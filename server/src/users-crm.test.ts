import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

/** B2 客户 CRM 钻取：订单史 + 累计已收 + 欠款（只读 join，admin 域）。 */

let db: DB
let app: App
let customerId: string
beforeEach(() => {
  db = makeTestDb()
  spoolInit(db, { baseCurrency: 'CNY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'initial-secret-pw' })
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

describe('GET /api/admin/users/:id/summary', () => {
  it('订单史 + 累计已收 + 欠款投影', async () => {
    const cust = await login('a@cust.example')
    const admin = await login('staff@folioria.jp')
    // total 1400 的订单
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: cust },
      payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }] },
    })
    const orderId = (created.json() as { id: string }).id
    await app.inject({ method: 'POST', url: `/api/orders/${orderId}/payments`, headers: { cookie: admin }, payload: { kind: 'deposit', amount: 700 } })

    const res = await app.inject({ method: 'GET', url: `/api/admin/users/${customerId}/summary`, headers: { cookie: admin } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      user: { id: string; email: string }
      stats: { order_count: number; active_count: number; total_paid: number; outstanding: number }
      orders: Array<{ order_number: string; total: number; paid_amount: number }>
    }
    expect(body.user.email).toBe('a@cust.example')
    expect(body.stats.order_count).toBe(1)
    expect(body.stats.total_paid).toBe(700)
    expect(body.stats.outstanding).toBe(700) // 1400 − 700
    expect(body.orders).toHaveLength(1)
    expect(body.orders[0]!.total).toBe(1400)
    expect(body.orders[0]!.paid_amount).toBe(700)
  })

  it('customer 调用 → 403；未知用户 / guest → 404', async () => {
    const cust = await login('a@cust.example')
    const admin = await login('staff@folioria.jp')
    expect((await app.inject({ method: 'GET', url: `/api/admin/users/${customerId}/summary`, headers: { cookie: cust } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/admin/users/nope/summary', headers: { cookie: admin } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/admin/users/guest/summary', headers: { cookie: admin } })).statusCode).toBe(404)
  })
})
