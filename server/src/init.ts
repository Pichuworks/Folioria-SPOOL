import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { type DB } from './db.js'

export const BCRYPT_ROUNDS = 12

export interface InitOptions {
  baseCurrency: string
  adminEmail: string
  adminName: string
  adminPassword: string
}

/** B1: 初始化实例——基准货币定格（产生数据后禁止变更）+ 初始 admin（首登强制改密 D11） */
export function spoolInit(db: DB, opts: InitOptions): void {
  if (db.prepare('SELECT 1 FROM system_config WHERE id = 1').get()) {
    throw new Error('spool init: already initialized (换币种 = 新实例)')
  }
  if (!db.prepare('SELECT 1 FROM currencies WHERE code = ?').get(opts.baseCurrency)) {
    throw new Error(`spool init: unknown currency ${opts.baseCurrency}`)
  }
  if (!opts.adminEmail.includes('@')) throw new Error('spool init: invalid admin email')
  if (opts.adminPassword.length < 8) throw new Error('spool init: admin password must be at least 8 chars')

  const hash = bcrypt.hashSync(opts.adminPassword, BCRYPT_ROUNDS)
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('INSERT INTO system_config (id, base_currency, initialized_at) VALUES (1, ?, ?)').run(
      opts.baseCurrency,
      now,
    )
    // D12: init 供给的 admin 同 admin 手动建号——视为已验证
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, role, must_change_password, email_verified_at, created_at)
       VALUES (?, ?, ?, ?, 'admin', 1, ?, ?)`,
    ).run(randomUUID(), opts.adminEmail, hash, opts.adminName, now, now)
  })()
}
