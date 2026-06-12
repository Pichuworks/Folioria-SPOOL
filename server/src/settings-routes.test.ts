import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

let db: DB
let app: App
let adminCookie: string
let memberCookie: string

beforeEach(async () => {
  db = makeTestDb()
  withSystemConfig(db)
  importSeed(db)
  createTestUser(db, { email: 'admin@t.jp', role: 'admin' })
  createTestUser(db, { email: 'member@t.jp', role: 'member' })
  app = buildApp(db)
  adminCookie = await login('admin@t.jp')
  memberCookie = await login('member@t.jp')
})
afterEach(async () => {
  await app.close()
  db.close()
})

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password' },
  })
  const token = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1]
  return `${SESSION_COOKIE}=${token}`
}

const get = async () => await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: adminCookie } })
const patch = async (payload: Record<string, unknown>) =>
  await app.inject({ method: 'PATCH', url: '/api/settings', payload, headers: { cookie: adminCookie } })

describe('F1 GET /api/settings', () => {
  it('管理域守卫：guest 401 / member 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: memberCookie } }))
        .statusCode,
    ).toBe(403)
  })

  it('返回 system_config 单行，bool 字段已映射', async () => {
    const res = await get()
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body['base_currency']).toBe('JPY')
    expect(body['min_margin_bp']).toBe(6700)
    expect(typeof body['unify_pricing']).toBe('boolean')
    expect(typeof body['force_min_margin']).toBe('boolean')
    expect(body['overhead_dep_months']).toBe(36)
    expect(body['overhead_month_volume']).toBe(2000)
    expect(body['quote_valid_days']).toBe(14)
  })
})

describe('F1 PATCH /api/settings', () => {
  it('部分更新生效，且下游报价随 min_margin_bp 变化（推导模型）', async () => {
    const before = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 3, size_key: 'A4', quantity: 100 },
    })
    expect((before.json() as { unit_price_c: number }).unit_price_c).toBe(22)

    const res = await patch({ min_margin_bp: 5000, quote_valid_days: 7 })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body['min_margin_bp']).toBe(5000)
    expect(body['quote_valid_days']).toBe(7)

    // total_c=7（acceptance §2.3 黑白×道林80 A4）→ ceil(7 / 0.5) = 14
    const after = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 3, size_key: 'A4', quantity: 100 },
    })
    expect((after.json() as { unit_price_c: number }).unit_price_c).toBe(14)
  })

  it('force_min_margin 布尔开关落库为 0/1', async () => {
    const res = await patch({ force_min_margin: true })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { force_min_margin: boolean }).force_min_margin).toBe(true)
    const row = db.prepare('SELECT force_min_margin FROM system_config WHERE id = 1').get() as {
      force_min_margin: number
    }
    expect(row.force_min_margin).toBe(1)
  })

  it('§7 边界：min_margin_bp=10000（地板价除零）/ 1.5 / "100" / 空 body → 422', async () => {
    expect((await patch({ min_margin_bp: 10000 })).statusCode).toBe(422)
    expect((await patch({ min_margin_bp: 1.5 })).statusCode).toBe(422)
    expect((await patch({ min_margin_bp: '100' })).statusCode).toBe(422)
    expect((await patch({})).statusCode).toBe(422)
  })

  it('initialized_at 不可经 PATCH 篡改（unknown 字段按全 API 惯例剥离）', async () => {
    const res = await patch({ initialized_at: '2030-01-01T00:00:00Z', quote_valid_days: 21 })
    expect(res.statusCode).toBe(200)
    const row = db.prepare('SELECT initialized_at, quote_valid_days FROM system_config WHERE id = 1').get() as {
      initialized_at: string
      quote_valid_days: number
    }
    expect(row.initialized_at).toBe('2026-06-10T00:00:00Z')
    expect(row.quote_valid_days).toBe(21)
  })

  it('base_currency：无业务数据可改；未知货币 409；产生业务数据后 409 locked', async () => {
    const unknown = await patch({ base_currency: 'EUR' })
    expect(unknown.statusCode).toBe(409)
    expect((unknown.json() as { error: string }).error).toBe('unknown_currency')

    const ok = await patch({ base_currency: 'CNY' })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { base_currency: string }).base_currency).toBe('CNY')

    db.prepare(
      `INSERT INTO inventory_log (id, target_type, target_id, action, quantity_delta, created_at)
       VALUES ('il-1', 'paper_stock', 'ps-1', 'purchase', 100, '2026-06-12T00:00:00Z')`,
    ).run()
    const locked = await patch({ base_currency: 'JPY' })
    expect(locked.statusCode).toBe(409)
    expect((locked.json() as { error: string }).error).toBe('base_currency_locked')

    // 锁定只针对 base_currency，其余字段仍可改
    expect((await patch({ quote_valid_days: 30 })).statusCode).toBe(200)
  })
})
