import { buildApp } from './app.js'
import { migrate, openDb } from './db.js'

const dbPath = process.env['SPOOL_DB'] ?? 'folioria.db'
const port = Number(process.env['PORT'] ?? 3000)
// S6: 默认 Secure；SPOOL_COOKIE_SECURE=0 仅限明文 HTTP 调试（生产必须 TLS 前置，
// 否则浏览器丢弃 cookie，登录静默失败）
const cookieSecure = process.env['SPOOL_COOKIE_SECURE'] !== '0'

const db = openDb(dbPath)
migrate(db)
const app = buildApp(db, { cookieSecure })

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => console.log(`spool server listening on http://127.0.0.1:${port} (db: ${dbPath})`))
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
