import { buildApp } from './app.js'
import { migrate, openDb } from './db.js'

const dbPath = process.env['SPOOL_DB'] ?? 'folioria.db'
const port = Number(process.env['PORT'] ?? 3000)

const db = openDb(dbPath)
migrate(db)
const app = buildApp(db)

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => console.log(`spool server listening on http://127.0.0.1:${port} (db: ${dbPath})`))
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
