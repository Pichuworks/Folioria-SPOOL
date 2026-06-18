import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import {
  createSession,
  userByToken,
  SESSION_TTL_DAYS,
  type SessionUser,
} from './auth.js'
import { type DB } from './db.js'
import { ERROR_SCHEMA } from './errors.js'
import { initLogger } from './logger.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { registerAlertsRoutes } from './alerts-routes.js'
import { registerAnnouncementsRoutes } from './announcements-routes.js'
import { registerAuthRoutes } from './auth-routes.js'
import { registerDashboardRoutes } from './dashboard-routes.js'
import { registerEquipmentRoutes } from './equipment-routes.js'
import { registerMembershipRoutes } from './membership-routes.js'
import { defaultUploadDir, registerFilesRoutes } from './files-routes.js'
import { registerInventoryRoutes } from './inventory-routes.js'
import { registerJobsRoutes } from './jobs-routes.js'
import { registerOrdersRoutes } from './orders-routes.js'
import { registerPricingRoutes } from './pricing-routes.js'
import { registerReportsRoutes } from './reports-routes.js'
import { registerSettingsRoutes } from './settings-routes.js'
import { registerUsersRoutes } from './users-routes.js'
import { userDto, USER_DTO_SCHEMA } from './user-dto.js'

export const SESSION_COOKIE = 'spool_session'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
}

export type App = FastifyInstance

export interface AppOptions {
  /** S6: session cookie 的 Secure 属性。默认 true；仅明文 HTTP 调试时关（生产必须 TLS 前置） */
  cookieSecure?: boolean
  /** R5: 上传隔离目录（默认 SPOOL_UPLOAD_DIR 或 ~/.local/share/spool/uploads） */
  uploadDir?: string
  /** R5: 单文件上限（默认 200MB；测试缩小） */
  uploadMaxBytes?: number
  /** review L-CSRF：是否强制 X-SPOOL-Request 头校验。默认 VITEST 下关、其余开；测试显式开以覆盖该防护 */
  enforceCsrf?: boolean
}

export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024


export function buildApp(db: DB, opts: AppOptions = {}): App {
  const cookieSecure = opts.cookieSecure ?? true
  const uploadDir = opts.uploadDir ?? defaultUploadDir()
  const uploadMaxBytes = opts.uploadMaxBytes ?? UPLOAD_MAX_BYTES
  const enforceCsrf = opts.enforceCsrf ?? !process.env['VITEST']
  const logLevel = (process.env['SPOOL_LOG_LEVEL'] ?? (process.env['VITEST'] ? 'silent' : 'info')) as 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  // coerceTypes 必须关死：金额字段传 "100"/1.5 须 422，不允许静默转换（acceptance §7）
  const app = Fastify({ logger: { level: logLevel }, trustProxy: true, ajv: { customOptions: { coerceTypes: false } } })
  initLogger(app.log)

  // acceptance §7: schema 校验失败一律 422
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as FastifyError
    if (err.validation) {
      req.log.info({ validationError: err.message }, 'schema validation 422')
      return reply.status(422).send({ error: 'validation_failed', message: err.message })
    }
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error(err)
    else if (status === 401 || status === 403) req.log.warn({ status, error: err.message }, 'auth rejection')
    else if (status >= 400) req.log.info({ status, error: err.message }, 'client error')
    return reply.status(status).send({ error: status >= 500 ? 'internal_error' : err.message })
  })

  void app.register(cookie)
  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
    hsts: { maxAge: 63072000, includeSubDomains: true },
  })
  // R5: 单文件单次（订单 item 级上传）；超限由 adapter 抛 413
  void app.register(multipart, { limits: { fileSize: uploadMaxBytes, files: 1 } })
  // PRD §6 限流：实例躲在 Cloudflare Tunnel 后，真实客户端 IP 在 CF-Connecting-IP
  void app.register(rateLimit, {
    global: true,
    max: parseInt(process.env['SPOOL_RATE_LIMIT'] ?? '120', 10),
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      // review L-cf-ip：cf-connecting-ip 是客户端可伪造头，无条件采信会让攻击者每请求换 IP 绕过限流。
      // 配置 SPOOL_CF_SECRET（由 cloudflared 注入 x-cf-secret 头）后仅采信密钥匹配的请求；
      // 未配置（dev/test）则维持原行为。两种情况下都回退到不可伪造的 req.ip。
      const cf = req.headers['cf-connecting-ip']
      const cfIp = Array.isArray(cf) ? cf[0] : cf
      const secret = process.env['SPOOL_CF_SECRET']
      const trusted = !secret || req.headers['x-cf-secret'] === secret
      return (trusted ? cfIp : undefined) ?? req.ip
    },
    onExceeded: (req) => {
      req.log.warn({ ip: req.ip }, 'rate limit exceeded')
    },
  })
  app.decorateRequest('user', null)
  // CSRF: state-changing requests must include X-SPOOL-Request header (SPA sets it; cross-origin forms cannot)
  if (enforceCsrf) {
    app.addHook('onRequest', (req, reply, done) => {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.headers['x-spool-request']) {
        void reply.status(403).send({ error: 'csrf_rejected' })
        return
      }
      done()
    })
  }
  app.addHook('preHandler', (req, _reply, done) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) {
      req.user = userByToken(db, token)
      if (!req.user) req.log.debug('session cookie present but invalid/expired/revoked')
    } else {
      req.user = null
    }
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
  registerMembershipRoutes(app, db)
  registerAuthRoutes(app, db, { cookieSecure, sessionCookie: SESSION_COOKIE })
  registerUsersRoutes(app, db)

  // health check (no auth, no rate-limit accounting)
  app.get('/api/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }))

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
        maxAge: SESSION_TTL_DAYS * 86_400,
      })
      return reply.status(201).send(userDto(userByToken(db, session) as SessionUser))
    },
  )

  })

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not_found' })
    }
    return reply.status(404).send('Not Found')
  })

  return app
}
