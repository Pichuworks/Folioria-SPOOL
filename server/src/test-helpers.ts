import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
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

export function createTestUser(
  db: DB,
  opts: { email: string; role?: 'customer' | 'member' | 'admin'; password?: string; name?: string },
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-06-10T00:00:00Z')`,
  ).run(
    id,
    opts.email,
    bcrypt.hashSync(opts.password ?? 'test-password', 4),
    opts.name ?? opts.email,
    opts.role ?? 'customer',
  )
  return id
}

/** acceptance §6：深度遍历响应 JSON，断言不得出现 cost/profit/margin 字样的键 */
export function collectForbiddenKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectForbiddenKeys(v, found)
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/cost|profit|margin/i.test(k)) found.push(k)
      collectForbiddenKeys(v, found)
    }
  }
  return found
}
