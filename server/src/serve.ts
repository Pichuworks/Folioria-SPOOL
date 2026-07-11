import { cleanupExpiredTokens } from './auth.js'
import { buildApp } from './app.js'
import { migrate, openDb } from './db.js'

const dbPath = process.env['SPOOL_DB'] ?? 'folioria.db'
const port = Number(process.env['PORT'] ?? 3000)
// S6: 默认 Secure；SPOOL_COOKIE_SECURE=0 仅限明文 HTTP 调试（生产必须 TLS 前置，
// 否则浏览器丢弃 cookie，登录静默失败）
const cookieSecure = process.env['SPOOL_COOKIE_SECURE'] !== '0'

const db = openDb(dbPath)
const applied = migrate(db)

// R5: 上传目录取 SPOOL_UPLOAD_DIR（默认 ~/.local/share/spool/uploads，files-routes 内解析）
const app = buildApp(db, { cookieSecure })

if (applied > 0) app.log.info({ applied }, 'migrations applied')

const priceScaleState = db
  .prepare('SELECT base_currency, pricing_needs_reentry FROM system_config WHERE id = 1')
  .get() as { base_currency: string; pricing_needs_reentry: number } | undefined
if (priceScaleState?.base_currency === 'CNY' && priceScaleState.pricing_needs_reentry !== 0) {
  app.log.warn(
    'CNY price layer requires review; inspect with `pnpm run cli pricing-scale inspect --db <file>` before marking canonical or repairing',
  )
}

if (process.env['SPOOL_RESEND_API_KEY'] && !process.env['SPOOL_PUBLIC_ORIGIN']) {
  app.log.warn('SPOOL_PUBLIC_ORIGIN not set — email links will contain localhost URLs')
}

// H-SEC-4: purge expired sessions/tokens on startup and every hour
cleanupExpiredTokens(db)
const cleanupTimer = setInterval(() => { try { cleanupExpiredTokens(db) } catch (e) { app.log.error(e, 'token cleanup failed') } }, 3_600_000)
cleanupTimer.unref()

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => app.log.info({ port, db: dbPath }, 'spool server listening'))
  .catch((err: unknown) => {
    app.log.fatal(err as Error, 'server startup failed')
    process.exit(1)
  })

function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down')
  void app.close().then(() => {
    db.close()
    app.log.info('shutdown complete')
    process.exit(0)
  })
  setTimeout(() => {
    app.log.error('shutdown timeout, forcing exit')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
