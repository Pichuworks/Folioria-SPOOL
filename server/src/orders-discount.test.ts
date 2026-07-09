import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { distributeDiscount } from './orders.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

/**
 * 回归（审查确认缺陷）：
 *  ① distributeDiscount 不得使任一行 share 超过其 line_total（否则 quoted_price 变负）。
 *  ② 折扣改动后 payment_status 须随新应付重算，且不得把应付压到已收之下。
 */

describe('distributeDiscount — Hamilton 分摊（每份 ∈ [0,line]，Σ=discount）', () => {
  const cases: ReadonlyArray<readonly [number, number[]]> = [
    [9, [3, 3, 3, 1]], // 旧实现把余额堆末行 → 末行 share 3 > line 1（负 quoted）
    [10, [3, 3, 3, 1]], // 满额折扣
    [1, [3, 3, 3, 1]],
    [7, [14, 90]],
    [5, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
    [99, [1, 1, 98]],
    [50, [100, 1]],
  ]
  it.each(cases)('discount %i over %j', (discount, lines) => {
    const subtotal = lines.reduce((a, b) => a + b, 0)
    const shares = distributeDiscount(discount, subtotal, lines)
    expect(shares.reduce((a, b) => a + b, 0)).toBe(discount) // 守恒（discount ≤ subtotal）
    for (let i = 0; i < lines.length; i++) {
      expect(shares[i]!).toBeGreaterThanOrEqual(0)
      expect(shares[i]!).toBeLessThanOrEqual(lines[i]!) // ⇒ line − share ≥ 0，quoted_price 非负
    }
  })

  it('discount 0 / 空 → 全 0', () => {
    expect(distributeDiscount(0, 10, [3, 3, 4])).toEqual([0, 0, 0])
    expect(distributeDiscount(5, 0, [])).toEqual([])
  })
})

describe('折扣改动后收款投影一致（D28）', () => {
  let db: DB
  let app: App
  beforeEach(() => {
    db = makeTestDb()
    spoolInit(db, { baseCurrency: 'CNY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'pw-initial-x' })
    importSeed(db)
    createTestUser(db, { email: 'a@cust.example' })
    createTestUser(db, { email: 'staff@folioria.jp', role: 'admin' })
    app = buildApp(db)
  })
  afterEach(async () => {
    await app.close()
    db.close()
  })
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
    const m = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
    return `${SESSION_COOKIE}=${m?.[1]}`
  }

  it('折扣压到已收之下 → 422；压到正好等于已收 → 投影 paid', async () => {
    const cust = await login('a@cust.example')
    const admin = await login('staff@folioria.jp')
    const created = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: cust }, payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }] } })
    const id = (created.json() as { id: string }).id // total 1400
    // 先收 1000（deposit）
    await app.inject({ method: 'POST', url: `/api/orders/${id}/payments`, headers: { cookie: admin }, payload: { kind: 'deposit', amount: 1000 } })

    // 折扣 600 → total 800 < 已收 1000 → 422
    const below = await app.inject({ method: 'PATCH', url: `/api/orders/${id}/discount`, headers: { cookie: admin }, payload: { discount: 600 } })
    expect(below.statusCode).toBe(422)
    expect((below.json() as { error: string }).error).toBe('discount_below_paid')

    // 折扣 400 → total 1000 == 已收 1000 → 200，投影 paid
    const ok = await app.inject({ method: 'PATCH', url: `/api/orders/${id}/discount`, headers: { cookie: admin }, payload: { discount: 400 } })
    expect(ok.statusCode).toBe(200)
    const o = ok.json() as { total: number; paid_amount: number; payment_status: string }
    expect(o.total).toBe(1000)
    expect(o.paid_amount).toBe(1000)
    expect(o.payment_status).toBe('paid') // 不再停留在 deposit
  })
})
