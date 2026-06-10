import { migrate, openDb, type DB } from './db.js'

export function makeTestDb(): DB {
  const db = openDb(':memory:')
  migrate(db)
  return db
}

export function withSystemConfig(db: DB, baseCurrency = 'JPY'): void {
  db.prepare(
    "INSERT INTO system_config (id, base_currency, initialized_at) VALUES (1, ?, '2026-06-10T00:00:00Z')",
  ).run(baseCurrency)
}
