import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import {
  changePassword,
  createSession,
  issueEmailVerification,
  revokeSession,
  userByToken,
  verifyEmail,
  verifyLogin,
  type SessionUser,
} from './auth.js'
import { type DB } from './db.js'
import { registerAlertsRoutes } from './alerts-routes.js'
import { registerDashboardRoutes } from './dashboard-routes.js'
import { registerEquipmentRoutes } from './equipment-routes.js'
import { requireAdmin } from './guards.js'
import { registerInventoryRoutes } from './inventory-routes.js'
import { registerJobsRoutes } from './jobs-routes.js'
import { registerOrdersRoutes } from './orders-routes.js'
import { registerPricingRoutes } from './pricing-routes.js'
import { registerReportsRoutes } from './reports-routes.js'
import { registerSettingsRoutes } from './settings-routes.js'

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
  name: string
  role: string
  must_change_password: boolean
  email_verified: boolean
}

const userDto = (u: SessionUser): UserDto => ({
  id: u.id,
  email: u.email,
  name: u.name,
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
    name: { type: 'string' },
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
}

/** 验证链接落在 web 哈希路由上（#/verify/:token），origin 由部署环境注入 */
export const verificationLink = (token: string): string =>
  `${process.env['SPOOL_PUBLIC_ORIGIN'] ?? 'http://localhost:5173'}/#/verify/${token}`

// R7 占位：块④接入 Notifier 抽象层（Resend adapter + notification_log 留痕）。
// 当前仅 dev 输出，无邮件 key 的本地链路从这里取验证链接。
async function sendVerificationEmail(_db: DB, to: string, token: string): Promise<void> {
  console.log(`[notify dev] email_verification → ${to}: ${verificationLink(token)}`)
}

export function buildApp(db: DB, opts: AppOptions = {}): App {
  const cookieSecure = opts.cookieSecure ?? true
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
  registerAlertsRoutes(app, db)
  registerDashboardRoutes(app, db)
  registerSettingsRoutes(app, db)
  registerReportsRoutes(app, db)

  // ---------- 下单域: auth ----------

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3 },
            password: { type: 'string', minLength: 1 },
          },
        },
        response: { 200: USER_DTO_SCHEMA, 401: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body as { email: string; password: string }
      const user = verifyLogin(db, email, password)
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
          `INSERT INTO users (id, email, password_hash, name, role, contact_info, created_at)
           VALUES (?, ?, ?, ?, 'customer', ?, ?)`,
        ).run(id, b.email, bcrypt.hashSync(b.password, 12), b.name, b.contact_info ?? null, new Date().toISOString())
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          return reply.status(409).send({ error: 'email_exists' })
        }
        throw err
      }
      const verifyToken = issueEmailVerification(db, id)
      await sendVerificationEmail(db, b.email, verifyToken)
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
      if (!changePassword(db, req.user.id, old_password, new_password, token)) {
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
        .prepare('SELECT id, email, name, role, archived, created_at FROM users ORDER BY created_at')
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
            name: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 8 },
            role: { type: 'string', enum: ['customer', 'member', 'admin'] },
          },
        },
        response: { 201: USER_DTO_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const body = req.body as { email: string; name: string; password: string; role: string }
      const id = randomUUID()
      try {
        // S3: 创建者知晓的初始密码不应永久有效 → 首登强制改密（D11 同初始 admin）。
        // D12: admin 手动供给的账号视为已验证（不走邮箱验证链路）
        db.prepare(
          `INSERT INTO users (id, email, password_hash, name, role, must_change_password, email_verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(id, body.email, bcrypt.hashSync(body.password, 12), body.name, body.role, new Date().toISOString(), new Date().toISOString())
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          return reply.status(409).send({ error: 'email_exists' })
        }
        throw err
      }
      return reply.status(201).send({
        id,
        email: body.email,
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
      const updated = db
        .prepare('SELECT id, email, name, role, must_change_password FROM users WHERE id = ?')
        .get(id) as SessionUser
      return userDto(updated)
    },
  )
  })

  return app
}
