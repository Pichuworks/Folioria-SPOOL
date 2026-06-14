import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

/** D29 审计：定价/折扣/收款/角色归档/设置 五个 choke-point 落 admin_audit；审阅视图。 */

let db: DB
let app: App
let customerId: string
beforeEach(() => {
  db = makeTestDb()
  spoolInit(db, { baseCurrency: 'JPY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'initial-secret-pw' })
  importSeed(db)
  customerId = createTestUser(db, { email: 'a@cust.example' })
  createTestUser(db, { email: 'staff@folioria.jp', role: 'admin' })
  app = buildApp(db)
})
afterEach(async () => {
  await app.close()
  db.close()
})

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
  const match = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
  return `${SESSION_COOKIE}=${match?.[1]}`
}

describe('admin_audit choke-points', () => {
  it('五类敏感变更各落一条审计；审阅视图倒序 + actor 名', async () => {
    const admin = await login('staff@folioria.jp')
    const cust = await login('a@cust.example')
    const order = (
      await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: cust }, payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }] } })
    ).json() as { id: string } // total 14

    // 定价
    await app.inject({ method: 'PUT', url: '/api/pricing/combos/1/prices/A4', headers: { cookie: admin }, payload: { sell_c: 8 } })
    // 折扣
    await app.inject({ method: 'PATCH', url: `/api/orders/${order.id}/discount`, headers: { cookie: admin }, payload: { discount: 2 } })
    // 收款
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payments`, headers: { cookie: admin }, payload: { kind: 'deposit', amount: 5, method: '现金' } })
    // 角色归档
    await app.inject({ method: 'PATCH', url: `/api/admin/users/${customerId}`, headers: { cookie: admin }, payload: { role: 'member' } })
    // 设置
    await app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie: admin }, payload: { quote_valid_days: 20 } })

    const res = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { cookie: admin } })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ action: string; actor_name: string; target_type: string; summary: string }>
    const actions = rows.map((r) => r.action)
    expect(actions).toContain('pricing.combo_price')
    expect(actions).toContain('order.discount')
    expect(actions).toContain('payment.record')
    expect(actions).toContain('user.update')
    expect(actions).toContain('settings.update')
    // 倒序：最近的 settings.update 在最前
    expect(rows[0]!.action).toBe('settings.update')
    // actor 名 join
    expect(rows.every((r) => r.actor_name === 'staff@folioria.jp')).toBe(true)
    // 收款摘要含 kind + 方式
    expect(rows.find((r) => r.action === 'payment.record')!.summary).toContain('deposit')
  })

  it('非 admin → 403', async () => {
    const cust = await login('a@cust.example')
    expect((await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { cookie: cust } })).statusCode).toBe(403)
  })
})
