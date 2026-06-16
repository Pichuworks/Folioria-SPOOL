import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
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
  type SessionUser,
} from './auth.js'
import { audit, listAudit } from './audit.js'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { formatMoney, money } from './money.js'
import { importSeed } from './seed.js'
import { registerAlertsRoutes } from './alerts-routes.js'
import { registerAnnouncementsRoutes } from './announcements-routes.js'
import { registerDashboardRoutes } from './dashboard-routes.js'
import { registerEquipmentRoutes } from './equipment-routes.js'
import { defaultUploadDir, registerFilesRoutes } from './files-routes.js'
import { requireAdmin } from './guards.js'
import { registerInventoryRoutes } from './inventory-routes.js'
import { registerJobsRoutes } from './jobs-routes.js'
import { notifyAddress, templates } from './notify.js'
import { registerOrdersRoutes } from './orders-routes.js'
import { registerPricingRoutes } from './pricing-routes.js'
import { registerReportsRoutes } from './reports-routes.js'
import { registerSettingsRoutes } from './settings-routes.js'
import { sendXlsx } from './xlsx.js'

export const SESSION_COOKIE = 'spool_session'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
}

export type App = FastifyInstance

interface UserDto {
  id: string
  email: string
  username: string | null
  name: string
  contact_info: string | null
  role: string
  must_change_password: boolean
  email_verified: boolean
}

const userDto = (u: SessionUser): UserDto => ({
  id: u.id,
  email: u.email,
  username: u.username,
  name: u.name,
  contact_info: u.contact_info,
  role: u.role,
  must_change_password: u.must_change_password !== 0,
  email_verified: u.email_verified_at != null,
})

const USER_DTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    username: { type: ['string', 'null'] },
    name: { type: 'string' },
    contact_info: { type: ['string', 'null'] },
    role: { type: 'string' },
    must_change_password: { type: 'boolean' },
    email_verified: { type: 'boolean' },
  },
}

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { error: { type: 'string' }, message: { type: 'string' } },
}

export interface AppOptions {
  /** S6: session cookie 的 Secure 属性。默认 true；仅明文 HTTP 调试时关（生产必须 TLS 前置） */
  cookieSecure?: boolean
  /** R5: 上传隔离目录（默认 SPOOL_UPLOAD_DIR 或 ~/.local/share/spool/uploads） */
  uploadDir?: string
  /** R5: 单文件上限（默认 200MB；测试缩小） */
  uploadMaxBytes?: number
}

export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024


export function buildApp(db: DB, opts: AppOptions = {}): App {
  const cookieSecure = opts.cookieSecure ?? true
  const uploadDir = opts.uploadDir ?? defaultUploadDir()
  const uploadMaxBytes = opts.uploadMaxBytes ?? UPLOAD_MAX_BYTES
  // coerceTypes 必须关死：金额字段传 "100"/1.5 须 422，不允许静默转换（acceptance §7）
  const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false } } })

  // acceptance §7: schema 校验失败一律 422
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as FastifyError
    if (err.validation) {
      return reply.status(422).send({ error: 'validation_failed', message: err.message })
    }
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error(err)
    return reply.status(status).send({ error: status >= 500 ? 'internal_error' : err.message })
  })

  void app.register(cookie)
  // R5: 单文件单次（订单 item 级上传）；超限由 adapter 抛 413
  void app.register(multipart, { limits: { fileSize: uploadMaxBytes, files: 1 } })
  // PRD §6 限流：实例躲在 Cloudflare Tunnel 后，真实客户端 IP 在 CF-Connecting-IP
  void app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => {
      const cf = req.headers['cf-connecting-ip']
      return (Array.isArray(cf) ? cf[0] : cf) ?? req.ip
    },
  })
  app.decorateRequest('user', null)
  app.addHook('preHandler', (req, _reply, done) => {
    const token = req.cookies[SESSION_COOKIE]
    req.user = token ? userByToken(db, token) : null
    done()
  })

  // 路由注册必须推迟到 rate-limit 插件之后：@fastify/rate-limit 经 onRoute 钩子装配，
  // 同步注册的路由会赶在插件 ready 之前、错过钩子导致 config.rateLimit 失效（PRD §6）。
  // 回调参数同名遮蔽外层 app；decorateRequest/preHandler/errorHandler 由父作用域继承。
  void app.register(async (app) => {
  registerPricingRoutes(app, db)
  registerInventoryRoutes(app, db)
  registerEquipmentRoutes(app, db)
  registerJobsRoutes(app, db)
  registerOrdersRoutes(app, db)
  registerFilesRoutes(app, db, uploadDir)
  registerAlertsRoutes(app, db)
  registerDashboardRoutes(app, db)
  registerSettingsRoutes(app, db)
  registerReportsRoutes(app, db)
  registerAnnouncementsRoutes(app, db)

  // ---------- 首次运行: Web 初始化向导（包住 CLI 同款 spoolInit，幂等自锁） ----------

  app.post(
    '/api/setup',
    {
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['base_currency', 'admin_email', 'admin_name', 'admin_password'],
          additionalProperties: false,
          properties: {
            base_currency: { type: 'string', minLength: 3, maxLength: 3 },
            admin_email: { type: 'string', minLength: 3, maxLength: 254 },
            admin_name: { type: 'string', minLength: 1, maxLength: 80 },
            admin_password: { type: 'string', minLength: 8, maxLength: 200 },
            seed: { type: 'boolean' },
          },
        },
        response: { 201: USER_DTO_SCHEMA, 409: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        base_currency: string
        admin_email: string
        admin_name: string
        admin_password: string
        seed?: boolean
      }
      try {
        // spoolInit 内含 id=1 守卫（已初始化抛错），是「仅未初始化可达」的真锁
        spoolInit(db, {
          baseCurrency: b.base_currency.toUpperCase(),
          adminEmail: b.admin_email,
          adminName: b.admin_name,
          adminPassword: b.admin_password,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('already initialized')) return reply.status(409).send({ error: 'already_initialized' })
        if (msg.includes('unknown currency')) return reply.status(422).send({ error: 'unknown_currency' })
        if (msg.includes('invalid admin email')) return reply.status(422).send({ error: 'invalid_email' })
        if (msg.includes('password must be')) return reply.status(422).send({ error: 'weak_password' })
        throw err
      }
      if (b.seed) importSeed(db)
      // 向导里 admin 自设密码，无需再强制改密（CLI 自动生成密码才需要）
      db.prepare('UPDATE users SET must_change_password = 0 WHERE email = ?').run(b.admin_email)
      const row = db.prepare('SELECT id FROM users WHERE email = ?').get(b.admin_email) as { id: string }
      const session = createSession(db, row.id)
      void reply.setCookie(SESSION_COOKIE, session, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure,
        path: '/',
      })
      return reply.status(201).send(userDto(userByToken(db, session) as SessionUser))
    },
  )

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
      if (!user) return reply.status(401).send({ error: 'invalid_credentials' })
      const token = createSession(db, user.id)
      void reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure,
        path: '/',
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
        if (err instanceof Error && err.message.includes('username')) {
          return reply.status(409).send({ error: 'username_taken' })
        }
        if (err instanceof Error && err.message.includes('UNIQUE')) {
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
    void reply.clearCookie(SESSION_COOKIE, { path: '/' })
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

  // ---------- 管理域: users（B1 账号供给） ----------

  app.get(
    '/api/admin/users',
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                username: { type: ['string', 'null'] },
                name: { type: 'string' },
                role: { type: 'string' },
                archived: { type: 'boolean' },
                created_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async () => {
      const rows = db
        .prepare(
          "SELECT id, email, username, name, role, archived, created_at FROM users WHERE id != 'guest' ORDER BY created_at",
        )
        .all() as Array<SessionUser & { archived: number; created_at: string }>
      return rows.map((r) => ({ ...r, archived: r.archived !== 0 }))
    },
  )

  app.post(
    '/api/admin/users',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['email', 'name', 'password', 'role'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3 },
            username: { type: 'string', pattern: '^[a-z0-9_]{3,30}$' },
            name: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 8 },
            role: { type: 'string', enum: ['customer', 'member', 'admin'] },
          },
        },
        response: { 201: USER_DTO_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const body = req.body as { email: string; username?: string; name: string; password: string; role: string }
      const id = randomUUID()
      try {
        // S3: 创建者知晓的初始密码不应永久有效 → 首登强制改密（D11 同初始 admin）。
        // D12: admin 手动供给的账号视为已验证（不走邮箱验证链路）
        const now = new Date().toISOString()
        db.prepare(
          `INSERT INTO users (id, email, username, password_hash, name, role, must_change_password, email_verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(id, body.email, body.username ?? null, await bcrypt.hash(body.password, 12), body.name, body.role, now, now)
      } catch (err) {
        // 部分唯一索引冲突报「index 'uniq_users_username'」，列约束报「users.email」；以 username 子串判别
        if (err instanceof Error && err.message.includes('username')) {
          return reply.status(409).send({ error: 'username_taken' })
        }
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          return reply.status(409).send({ error: 'email_exists' })
        }
        throw err
      }
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'user.create',
        targetType: 'user',
        targetId: id,
        summary: `创建 ${body.role} · ${body.email}`,
      })
      return reply.status(201).send({
        id,
        email: body.email,
        username: body.username ?? null,
        name: body.name,
        role: body.role,
        must_change_password: true,
        email_verified: true,
      })
    },
  )

  app.patch(
    '/api/admin/users/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            role: { type: 'string', enum: ['customer', 'member', 'admin'] },
            archived: { type: 'boolean' },
          },
        },
        response: { 200: USER_DTO_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = req.body as { role?: string; archived?: boolean }
      const existing = db
        .prepare('SELECT id, email, name, role, must_change_password, archived FROM users WHERE id = ?')
        .get(id) as (SessionUser & { archived: number }) | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      // S1: 最后一个活跃 admin 不可归档/降格（防实例永久失管）
      const losesAdmin =
        (body.role !== undefined && body.role !== 'admin') || body.archived === true
      if (existing.role === 'admin' && existing.archived === 0 && losesAdmin) {
        const { n } = db
          .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND archived = 0")
          .get() as { n: number }
        if (n <= 1) return reply.status(409).send({ error: 'last_admin' })
      }
      db.prepare('UPDATE users SET role = ?, archived = ? WHERE id = ?').run(
        body.role ?? existing.role,
        body.archived === undefined ? existing.archived : body.archived ? 1 : 0,
        id,
      )
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'user.update',
        targetType: 'user',
        targetId: id,
        summary: [
          body.role !== undefined && body.role !== existing.role ? `角色 ${existing.role}→${body.role}` : null,
          body.archived !== undefined && (body.archived ? 1 : 0) !== existing.archived
            ? body.archived
              ? '归档'
              : '恢复'
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || '无变更',
      })
      const updated = db
        .prepare('SELECT id, email, name, role, must_change_password FROM users WHERE id = ?')
        .get(id) as SessionUser
      return userDto(updated)
    },
  )

  // D29 审计审阅视图（admin）：倒序最近 200 条，actor 名 join
  app.get('/api/admin/audit', { preHandler: requireAdmin }, async () =>
    listAudit(db).map((a) => ({
      id: a.id,
      actor_id: a.actor_id,
      actor_name: a.actor_name,
      action: a.action,
      target_type: a.target_type,
      target_id: a.target_id,
      summary: a.summary,
      created_at: a.created_at,
    })),
  )

  app.get('/api/admin/audit/export', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = listAudit(db, 5000)
    return sendXlsx(reply, 'audit.xlsx', [
      {
        name: '操作审计',
        columns: [
          { header: '时间', key: 'created_at', width: 20 },
          { header: '操作', key: 'action', width: 18 },
          { header: '操作人', key: 'actor_name', width: 14 },
          { header: '目标类型', key: 'target_type', width: 12 },
          { header: '目标ID', key: 'target_id', width: 20 },
          { header: '摘要', key: 'summary', width: 35 },
        ],
        rows,
      },
    ])
  })

  // B2 客户 CRM 钻取（只读 join）：订单史 + 累计已收 + 欠款 + 联系方式
  app.get(
    '/api/admin/users/:id/summary',
    {
      preHandler: requireAdmin,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const user = db
        .prepare("SELECT id, email, username, name, role, contact_info, created_at FROM users WHERE id = ? AND id != 'guest'")
        .get(id) as
        | { id: string; email: string; username: string | null; name: string; role: string; contact_info: string | null; created_at: string }
        | undefined
      if (!user) return reply.status(404).send({ error: 'not_found' })
      const currency = baseCurrency(db)
      const orders = db
        .prepare(
          `SELECT id, order_number, status, total, paid_amount, created_at
           FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 200`,
        )
        .all(id) as Array<{ id: string; order_number: string; status: string; total: number; paid_amount: number; created_at: string }>
      let totalPaid = 0
      let outstanding = 0
      let activeCount = 0
      for (const o of orders) {
        totalPaid += o.paid_amount
        if (o.status !== 'cancelled') {
          outstanding += o.total - o.paid_amount
          activeCount += 1
        }
      }
      return {
        user,
        stats: {
          order_count: orders.length,
          active_count: activeCount,
          total_paid: totalPaid,
          total_paid_display: formatMoney(money(totalPaid), currency),
          outstanding,
          outstanding_display: formatMoney(money(outstanding), currency),
        },
        orders: orders.map((o) => ({
          ...o,
          total_display: formatMoney(money(o.total), currency),
          paid_amount_display: formatMoney(money(o.paid_amount), currency),
        })),
      }
    },
  )
  })

  return app
}
