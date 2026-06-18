import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { type FastifyInstance } from 'fastify'
import {
  changePassword,
  createSession,
  findUserForReset,
  issueEmailVerification,
  issuePasswordReset,
  resetPassword,
  revokeSession,
  userByToken,
  verifyEmail,
  verifyLogin,
  SESSION_TTL_DAYS,
  type SessionUser,
} from './auth.js'
import { type DB } from './db.js'
import { ERROR_SCHEMA, isConstraint } from './errors.js'
import { notifyAddress, templates } from './notify.js'
import { userDto, USER_DTO_SCHEMA } from './user-dto.js'

export function registerAuthRoutes(
  app: FastifyInstance,
  db: DB,
  opts: { cookieSecure: boolean; sessionCookie: string },
): void {
  const { cookieSecure } = opts
  const SESSION_COOKIE = opts.sessionCookie

  // ---------- 下单域: auth ----------

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: {
            // D18: identifier = 用户名或邮箱；保留 email 为向后兼容别名
            identifier: { type: 'string', minLength: 3, maxLength: 254 },
            email: { type: 'string', minLength: 3, maxLength: 254 },
            password: { type: 'string', minLength: 1 },
          },
        },
        response: { 200: USER_DTO_SCHEMA, 401: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { identifier, email, password } = req.body as {
        identifier?: string
        email?: string
        password: string
      }
      const who = identifier ?? email
      if (!who) return reply.status(422).send({ error: 'identifier_required' })
      const user = await verifyLogin(db, who, password)
      if (!user) {
        req.log.info({ identifier: who.slice(0, 3) + '***' }, 'login failed')
        return reply.status(401).send({ error: 'invalid_credentials' })
      }
      const token = createSession(db, user.id)
      void reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure,
        path: '/',
        maxAge: SESSION_TTL_DAYS * 86_400,
      })
      return userDto(user)
    },
  )

  // R4/D10: 下单域开放注册——role 恒 customer（白名单拒绝 role 键），即注册即登录；
  // 邮箱验证另走 verify-email（未验证可登录，但下单被 403 email_unverified 拦）
  app.post(
    '/api/auth/register',
    {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'name', 'password'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
            username: { type: 'string', pattern: '^[a-z0-9_]{3,30}$' },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            password: { type: 'string', minLength: 8, maxLength: 200 },
            contact_info: { type: ['string', 'null'], maxLength: 200 },
            invite_code: { type: 'string', maxLength: 100 },
          },
        },
        response: { 201: USER_DTO_SCHEMA, 403: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        email: string
        username?: string
        name: string
        password: string
        contact_info?: string | null
        invite_code?: string
      }
      const cfg = db
        .prepare('SELECT registration_open, invite_code FROM system_config WHERE id = 1')
        .get() as { registration_open: number; invite_code: string | null } | undefined
      if (!cfg || cfg.registration_open === 0) {
        return reply.status(403).send({ error: 'registration_closed' })
      }
      if (cfg.invite_code != null && b.invite_code !== cfg.invite_code) {
        return reply.status(403).send({ error: 'invalid_invite_code' })
      }
      const id = randomUUID()
      try {
        db.prepare(
          `INSERT INTO users (id, email, username, password_hash, name, role, contact_info, created_at)
           VALUES (?, ?, ?, ?, ?, 'customer', ?, ?)`,
        ).run(id, b.email, b.username ?? null, await bcrypt.hash(b.password, 12), b.name, b.contact_info ?? null, new Date().toISOString())
      } catch (err) {
        // 部分唯一索引冲突报「index 'uniq_users_username'」，列约束报「users.email」；以 username 子串判别
        if (isConstraint(err, 'username')) {
          return reply.status(409).send({ error: 'username_taken' })
        }
        if (isConstraint(err, 'UNIQUE')) {
          return reply.status(409).send({ error: 'email_exists' })
        }
        throw err
      }
      const verifyToken = issueEmailVerification(db, id)
      // R7: 分发永不抛错（无 key → skipped 落 notification_log），注册不被邮件阻塞
      await notifyAddress(db, 'email_verification', b.email, templates.emailVerification(verifyToken))
      const session = createSession(db, id)
      void reply.setCookie(SESSION_COOKIE, session, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure,
        path: '/',
        maxAge: SESSION_TTL_DAYS * 86_400,
      })
      const user = userByToken(db, session) as SessionUser
      return reply.status(201).send(userDto(user))
    },
  )

  app.post(
    '/api/auth/verify-email',
    {
      config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 1, maxLength: 200 } },
        },
        response: { 204: { type: 'null' }, 404: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { token } = req.body as { token: string }
      // 无效/过期/已消费一律 404，不泄露 token 存在性
      if (!verifyEmail(db, token)) return reply.status(404).send({ error: 'invalid_or_expired_token' })
      return reply.status(204).send()
    },
  )

  // D19: 忘记密码——请求重置。无论账号是否存在一律 204（不泄露存在性）；存在则发重置邮件
  app.post(
    '/api/auth/forgot-password',
    {
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['identifier'],
          additionalProperties: false,
          properties: { identifier: { type: 'string', minLength: 3, maxLength: 254 } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (req, reply) => {
      const { identifier } = req.body as { identifier: string }
      const user = findUserForReset(db, identifier)
      if (user) {
        const token = issuePasswordReset(db, user.id)
        // 分发永不抛错（无 key → skipped 落 notification_log）
        await notifyAddress(db, 'password_reset', user.email, templates.passwordReset(token))
      }
      return reply.status(204).send()
    },
  )

  // D19: 重置密码——一次性 token。无效/过期/已用一律 404（不泄露 token 存在性）
  app.post(
    '/api/auth/reset-password',
    {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['token', 'new_password'],
          additionalProperties: false,
          properties: {
            token: { type: 'string', minLength: 1, maxLength: 200 },
            new_password: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
        response: { 204: { type: 'null' }, 404: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { token, new_password } = req.body as { token: string; new_password: string }
      if (!(await resetPassword(db, token, new_password))) {
        return reply.status(404).send({ error: 'invalid_or_expired_token' })
      }
      return reply.status(204).send()
    },
  )

  app.post('/api/auth/logout', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) revokeSession(db, token)
    void reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure })
    return reply.status(204).send()
  })

  app.get(
    '/api/auth/me',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { response: { 200: USER_DTO_SCHEMA, 401: ERROR_SCHEMA } },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: 'unauthorized' })
      return userDto(req.user)
    },
  )

  // 下单域账号资料编辑（称呼 / 联系方式）；email/username 不在此改（登录/通知主键）
  app.patch(
    '/api/auth/profile',
    {
      config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            contact_info: { type: ['string', 'null'], maxLength: 200 },
          },
        },
        response: { 200: USER_DTO_SCHEMA, 401: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: 'unauthorized' })
      const b = req.body as { name?: string; contact_info?: string | null }
      const u = req.user
      db.prepare('UPDATE users SET name = ?, contact_info = ? WHERE id = ?').run(
        b.name ?? u.name,
        'contact_info' in b ? (b.contact_info ?? null) : u.contact_info,
        u.id,
      )
      const fresh = db
        .prepare(
          'SELECT id, email, username, name, contact_info, role, must_change_password, email_verified_at FROM users WHERE id = ?',
        )
        .get(u.id) as SessionUser
      return userDto(fresh)
    },
  )

  // C3 通知偏好（目前仅 email channel）：notify_channels 选渠道，notify_addresses 可覆盖收件地址（缺省=账号邮箱）
  const NOTIFY_PREFS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      channels: { type: 'array', items: { type: 'string' } },
      addresses: { type: 'object', additionalProperties: false, properties: { email: { type: ['string', 'null'] } } },
      account_email: { type: 'string' },
    },
  }

  app.get(
    '/api/auth/notify-prefs',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { response: { 200: NOTIFY_PREFS_SCHEMA, 401: ERROR_SCHEMA } },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: 'unauthorized' })
      const row = db
        .prepare('SELECT email, notify_channels, notify_addresses FROM users WHERE id = ?')
        .get(req.user.id) as { email: string; notify_channels: string; notify_addresses: string }
      let channels: string[]
      let addresses: Record<string, string>
      try {
        channels = JSON.parse(row.notify_channels) as string[]
        addresses = JSON.parse(row.notify_addresses) as Record<string, string>
      } catch {
        channels = ['email']
        addresses = {}
      }
      return { channels, addresses, account_email: row.email }
    },
  )

  app.patch(
    '/api/auth/notify-prefs',
    {
      config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            // 已知渠道白名单（当前仅 email）；未知渠道被剔除
            channels: { type: 'array', items: { type: 'string', enum: ['email'] }, uniqueItems: true },
            addresses: {
              type: 'object',
              additionalProperties: false,
              properties: { email: { type: ['string', 'null'], maxLength: 254 } },
            },
          },
        },
        response: { 200: NOTIFY_PREFS_SCHEMA, 401: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: 'unauthorized' })
      const b = req.body as { channels?: string[]; addresses?: { email?: string | null } }
      const row = db
        .prepare('SELECT email, notify_channels, notify_addresses FROM users WHERE id = ?')
        .get(req.user.id) as { email: string; notify_channels: string; notify_addresses: string }
      let channels: string[]
      let addresses: Record<string, string>
      try {
        channels = JSON.parse(row.notify_channels) as string[]
        addresses = JSON.parse(row.notify_addresses) as Record<string, string>
      } catch {
        channels = ['email']
        addresses = {}
      }
      if (b.channels !== undefined) channels = b.channels
      if (b.addresses !== undefined && 'email' in b.addresses) {
        const v = b.addresses.email
        if (v == null || v.trim() === '') delete addresses['email']
        else {
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())) return reply.status(422).send({ error: 'invalid_email' })
          addresses['email'] = v.trim()
        }
      }
      db.prepare('UPDATE users SET notify_channels = ?, notify_addresses = ? WHERE id = ?').run(
        JSON.stringify(channels),
        JSON.stringify(addresses),
        req.user.id,
      )
      return { channels, addresses, account_email: row.email }
    },
  )

  app.post(
    '/api/auth/change-password',
    {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['old_password', 'new_password'],
          additionalProperties: false,
          properties: {
            old_password: { type: 'string', minLength: 1 },
            new_password: { type: 'string', minLength: 8 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: 'unauthorized' })
      const { old_password, new_password } = req.body as {
        old_password: string
        new_password: string
      }
      const token = req.cookies[SESSION_COOKIE]
      if (!(await changePassword(db, req.user.id, old_password, new_password, token))) {
        return reply.status(401).send({ error: 'invalid_credentials' })
      }
      return reply.status(204).send()
    },
  )
}
