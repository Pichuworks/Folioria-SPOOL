import bcrypt from 'bcryptjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from './app.js'
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
      .prepare("SELECT email, password_hash, role, must_change_password FROM users WHERE role = 'admin'")
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
    expect((db.prepare('SELECT COUNT(*) n FROM sizes').get() as { n: number }).n).toBe(31)
  })
})
describe('POST /api/setup（Web 初始化向导）', () => {
  let db: DB
  let app: App
  beforeEach(() => {
    db = makeTestDb()
    app = buildApp(db)
  })
  afterEach(async () => {
    await app.close()
    db.close()
  })

  it('未初始化→建实例+自动登录(admin,不强制改密,导入 seed)，重复→409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { base_currency: 'JPY', admin_email: 'boss@folioria.jp', admin_name: '老板', admin_password: 'a-strong-pass-1', seed: true },
    })
    expect(res.statusCode).toBe(201)
    const me = res.json() as { role: string; must_change_password: boolean }
    expect(me.role).toBe('admin')
    expect(me.must_change_password).toBe(false)
    expect(String(res.headers['set-cookie'])).toContain('spool_session=')
    expect((db.prepare('SELECT COUNT(*) n FROM sizes').get() as { n: number }).n).toBe(31)
    const cfg = await app.inject({ method: 'GET', url: '/api/public-config' })
    expect((cfg.json() as { initialized: boolean }).initialized).toBe(true)
    const again = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { base_currency: 'USD', admin_email: 'x@y.jp', admin_name: 'X', admin_password: 'another-pass-1' },
    })
    expect(again.statusCode).toBe(409)
  })

  it('未知货币 / 邮箱无@ / 弱口令 → 422', async () => {
    const setup = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/setup', payload })
    expect((await setup({ base_currency: 'EUR', admin_email: 'a@b.jp', admin_name: 'A', admin_password: 'a-strong-pass-1' })).statusCode).toBe(422)
    expect((await setup({ base_currency: 'JPY', admin_email: 'no-at', admin_name: 'A', admin_password: 'a-strong-pass-1' })).statusCode).toBe(422)
    expect((await setup({ base_currency: 'JPY', admin_email: 'a@b.jp', admin_name: 'A', admin_password: 'short' })).statusCode).toBe(422)
  })
})
