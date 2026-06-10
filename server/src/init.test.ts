import bcrypt from 'bcryptjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { makeTestDb } from './test-helpers.js'

const OPTS = {
  baseCurrency: 'JPY',
  adminEmail: 'admin@folioria.jp',
  adminName: 'K君',
  adminPassword: 'correct-horse-battery',
}

describe('spool init（B1：初始 admin + 基准货币）', () => {
  let db: DB
  beforeEach(() => {
    db = makeTestDb()
  })
  afterEach(() => {
    db.close()
  })

  it('创建 system_config（base_currency 定格）与 admin（首登强制改密）', () => {
    spoolInit(db, OPTS)

    const cfg = db
      .prepare('SELECT base_currency, initialized_at FROM system_config WHERE id = 1')
      .get() as { base_currency: string; initialized_at: string }
    expect(cfg.base_currency).toBe('JPY')
    expect(cfg.initialized_at).toBeTruthy()

    const admin = db
      .prepare('SELECT email, password_hash, role, must_change_password FROM users')
      .get() as {
      email: string
      password_hash: string
      role: string
      must_change_password: number
    }
    expect(admin.role).toBe('admin')
    expect(admin.must_change_password).toBe(1)
    expect(admin.password_hash).not.toContain(OPTS.adminPassword)
    expect(bcrypt.compareSync(OPTS.adminPassword, admin.password_hash)).toBe(true)
  })

  it('重复 init 拒绝（换币种 = 新实例）', () => {
    spoolInit(db, OPTS)
    expect(() => spoolInit(db, { ...OPTS, baseCurrency: 'USD' })).toThrow(/already initialized/i)
  })

  it('基准货币必须在注册表内', () => {
    expect(() => spoolInit(db, { ...OPTS, baseCurrency: 'EUR' })).toThrow(/unknown currency/i)
  })

  it('弱口令拒绝', () => {
    expect(() => spoolInit(db, { ...OPTS, adminPassword: 'short' })).toThrow(/password/i)
  })

  it('init 后可正常导入 seed', () => {
    spoolInit(db, OPTS)
    importSeed(db)
    expect((db.prepare('SELECT COUNT(*) n FROM sizes').get() as { n: number }).n).toBe(6)
  })
})
