import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { collectForbiddenKeys, createTestUser, makeTestDb } from './test-helpers.js'

/**
 * D27 书行下单（acceptance §5/§6 同口径：unit_price_c 定格快照；下单域无 cost/profit/margin；机器对客户不可见）。
 * seed 基准书：封面 color·paper6·A3 = 88_c；内页 bw·paper1·A4 = 7_c。
 */

let db: DB
let app: App
let bookId: number
let innerId: number
let coverId: number

beforeEach(() => {
  db = makeTestDb()
  spoolInit(db, {
    baseCurrency: 'JPY',
    adminEmail: 'admin@folioria.jp',
    adminName: 'K君',
    adminPassword: 'initial-secret-pw',
  })
  importSeed(db)
  createTestUser(db, { email: 'a@cust.example' })
  createTestUser(db, { email: 'staff@folioria.jp', role: 'admin' })
  app = buildApp(db)

  bookId = Number(db.prepare("INSERT INTO book_products (name) VALUES ('写真集')").run().lastInsertRowid)
  coverId = Number(
    db
      .prepare(
        "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'cover', 6, 'A3', 'color', 0, 0)",
      )
      .run(bookId).lastInsertRowid,
  )
  innerId = Number(
    db
      .prepare(
        "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'inner', 1, 'A4', 'bw', 0, 1)",
      )
      .run(bookId).lastInsertRowid,
  )
  const bind = Number(
    db.prepare("INSERT INTO finishing_ops (name, pricing, price_c) VALUES ('骑马钉', 'per_book', 2000)").run()
      .lastInsertRowid,
  )
  const num = Number(
    db.prepare("INSERT INTO finishing_ops (name, pricing, price_c) VALUES ('页码', 'per_page', 3)").run()
      .lastInsertRowid,
  )
  db.prepare('INSERT INTO book_finishings (book_id, finishing_id) VALUES (?, ?)').run(bookId, bind)
  db.prepare('INSERT INTO book_finishings (book_id, finishing_id) VALUES (?, ?)').run(bookId, num)
})
afterEach(async () => {
  await app.close()
  db.close()
})

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
  expect(res.statusCode).toBe(200)
  const match = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
  return `${SESSION_COOKIE}=${match?.[1]}`
}

const bookLine = (count: number, innerSheets: number) => ({
  book_id: bookId,
  count,
  components: [{ component_id: innerId, sheets_per_book: innerSheets }],
})

describe('§D27 书行下单', () => {
  it('一本书一行：unit_price_c 定格、line_total 唯一舍入点、subtotal 含书行', async () => {
    const cookie = await login('a@cust.example')
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { books: [bookLine(5, 10)] },
    })
    expect(res.statusCode).toBe(201)
    const order = res.json() as {
      subtotal: number
      total: number
      items: unknown[]
      books: Array<{ unit_price_c: number; line_total: number; count: number; components: unknown[]; finishings: unknown[] }>
    }
    expect(order.items).toHaveLength(0)
    expect(order.books).toHaveLength(1)
    // 组件 88 + 7×10=70 → 158；per_book 2000；per_page 3×11=33 → unit 2191
    expect(order.books[0]!.unit_price_c).toBe(2191)
    // lineTotal(2191, 5) = round_half_up(109.55) = 110
    expect(order.books[0]!.line_total).toBe(110)
    expect(order.subtotal).toBe(110)
    expect(order.total).toBe(110)
    expect(order.books[0]!.components).toHaveLength(2) // 封面 + 内页
    expect(order.books[0]!.finishings).toHaveLength(2)
  })

  it('机器对客户不可见：组件无 mode_id；admin 视图有', async () => {
    const cust = await login('a@cust.example')
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: cust },
      payload: { books: [bookLine(1, 5)] },
    })
    const order = created.json() as { id: string; books: Array<{ components: Array<Record<string, unknown>> }> }
    for (const c of order.books[0]!.components) {
      expect(c).not.toHaveProperty('mode_id')
      expect(c).not.toHaveProperty('job_id')
    }

    const admin = await login('staff@folioria.jp')
    const adminView = await app.inject({ method: 'GET', url: `/api/orders/${order.id}`, headers: { cookie: admin } })
    const adminOrder = adminView.json() as { books: Array<{ components: Array<Record<string, unknown>> }> }
    for (const c of adminOrder.books[0]!.components) {
      expect(c).toHaveProperty('mode_id')
    }
    // 封面 color·paper6·A3 → mode 4；内页 bw·paper1·A4 → mode 1
    const modeIds = adminOrder.books[0]!.components.map((c) => c['mode_id']).sort()
    expect(modeIds).toEqual([1, 4])
  })

  it('§6 下单域响应无 cost/profit/margin 键（书行深度遍历）', async () => {
    const cookie = await login('a@cust.example')
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { books: [bookLine(2, 8)] },
    })
    expect(collectForbiddenKeys(res.json())).toEqual([])
  })

  it('混合单：单页 item + 书行，subtotal 守恒整数加法', async () => {
    const cookie = await login('a@cust.example')
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }], // 7×200/100 = 14
        books: [bookLine(5, 10)], // line_total 110
      },
    })
    expect(res.statusCode).toBe(201)
    const order = res.json() as { items: Array<{ line_total: number }>; books: Array<{ line_total: number }>; subtotal: number }
    expect(order.items[0]!.line_total).toBe(14)
    expect(order.books[0]!.line_total).toBe(110)
    expect(order.subtotal).toBe(124)
  })

  it('unit_price_c 下单定格：改工艺价不动既有书单', async () => {
    const cookie = await login('a@cust.example')
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { books: [bookLine(5, 10)] },
    })
    const id = (created.json() as { id: string }).id
    // 工艺涨价
    db.prepare("UPDATE finishing_ops SET price_c = 99999 WHERE name = '骑马钉'").run()
    const refetched = await app.inject({ method: 'GET', url: `/api/orders/${id}`, headers: { cookie } })
    const order = refetched.json() as { books: Array<{ unit_price_c: number; line_total: number }> }
    expect(order.books[0]!.unit_price_c).toBe(2191) // 不变
    expect(order.books[0]!.line_total).toBe(110)
  })

  it('空单（无 item 无 book）→ 422 empty_order', async () => {
    const cookie = await login('a@cust.example')
    const res = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload: {} })
    expect(res.statusCode).toBe(422)
  })

  it('内页缺张数 → 422', async () => {
    const cookie = await login('a@cust.example')
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { books: [{ book_id: bookId, count: 1, components: [] }] },
    })
    expect(res.statusCode).toBe(422)
    void coverId
  })
})
