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
    // 组件 88 + 7×10=70 → 158；per_book 2000；per_page 3×11=33 → unit 2185
    expect(order.books[0]!.unit_price_c).toBe(2185)
    // lineTotal(2185, 5) = round_half_up(109.55) = 110
    expect(order.books[0]!.line_total).toBe(109)
    expect(order.subtotal).toBe(109)
    expect(order.total).toBe(109)
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
        books: [bookLine(5, 10)], // line_total 109
      },
    })
    expect(res.statusCode).toBe(201)
    const order = res.json() as { items: Array<{ line_total: number }>; books: Array<{ line_total: number }>; subtotal: number }
    expect(order.items[0]!.line_total).toBe(14)
    expect(order.books[0]!.line_total).toBe(109)
    expect(order.subtotal).toBe(123)
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
    expect(order.books[0]!.unit_price_c).toBe(2185) // 不变
    expect(order.books[0]!.line_total).toBe(109)
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

  it('D32 source_component_id 下单定格：组件回指目录 book_components.id（封面/内页各对应）', async () => {
    const cookie = await login('a@cust.example')
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { books: [bookLine(3, 8)] },
    })
    expect(created.statusCode).toBe(201)
    const id = (created.json() as { id: string }).id
    // DB 落账：每个 order_book_component.source_component_id 指回目录组件 id
    const rows = db
      .prepare(
        `SELECT obc.role, obc.source_component_id
         FROM order_book_components obc
         WHERE obc.order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)
         ORDER BY obc.rowid`,
      )
      .all(id) as Array<{ role: string; source_component_id: number | null }>
    expect(rows.find((r) => r.role === 'cover')!.source_component_id).toBe(coverId)
    expect(rows.find((r) => r.role === 'inner')!.source_component_id).toBe(innerId)

    // DTO（admin 与 customer 两域）均回显 source_component_id
    const admin = await login('staff@folioria.jp')
    const view = await app.inject({ method: 'GET', url: `/api/orders/${id}`, headers: { cookie: admin } })
    const comps = (view.json() as { books: Array<{ components: Array<{ role: string; source_component_id: number | null }> }> })
      .books[0]!.components
    expect(comps.find((c) => c.role === 'inner')!.source_component_id).toBe(innerId)
  })
})
describe('§D27 书行 confirm → 组件作业 / cancel 连带 / done 落账', () => {
  /** 下单（customer）→ 返回 order id */
  async function placeBookOrder(innerSheets = 10, count = 5): Promise<string> {
    const cookie = await login('a@cust.example')
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { books: [bookLine(count, innerSheets)] },
    })
    expect(res.statusCode).toBe(201)
    return (res.json() as { id: string }).id
  }

  /** D31: 书组件现有文件门，confirm 前须全部组件有文件且 approved。本组件作业测试用 DB 捷径推进到 file_approved */
  function approveAllComponents(id: string): void {
    db.prepare(
      `UPDATE order_book_components SET file_url = 'seed.pdf', file_status = 'approved'
       WHERE order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)`,
    ).run(id)
    db.prepare("UPDATE orders SET status = 'file_approved' WHERE id = ?").run(id)
  }

  /** 下单并推进到 file_approved（审稿过），返回可 confirm 的 order id */
  async function placeApprovedBookOrder(innerSheets = 10, count = 5): Promise<string> {
    const id = await placeBookOrder(innerSheets, count)
    approveAllComponents(id)
    return id
  }

  it('D31 书组件文件门：未审稿时 quoted 直接 confirm → 409 not_confirmable', async () => {
    const id = await placeBookOrder()
    const admin = await login('staff@folioria.jp')
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${id}/status`,
      headers: { cookie: admin },
      payload: { status: 'confirmed' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe('not_confirmable_from_quoted')
  })

  it('书单审稿过后 confirm：拆出每组件一道 Job(queued)', async () => {
    const id = await placeApprovedBookOrder()
    const admin = await login('staff@folioria.jp')
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${id}/status`,
      headers: { cookie: admin },
      payload: { status: 'confirmed' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { status: string }).status).toBe('confirmed')

    // 组件作业：封面(1×5=5) + 内页(10×5=50)，均 queued，order_item_id NULL
    const jobs = db
      .prepare(
        `SELECT j.mode_id, j.paper_id, j.size_key, j.quantity, j.quoted_price, j.status, j.order_item_id, obc.role
         FROM order_book_components obc JOIN jobs j ON j.id = obc.job_id
         WHERE obc.order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)
         ORDER BY obc.rowid`,
      )
      .all(id) as Array<{ mode_id: number; quantity: number; quoted_price: number; status: string; order_item_id: string | null; role: string }>
    expect(jobs).toHaveLength(2)
    expect(jobs.every((j) => j.status === 'queued')).toBe(true)
    expect(jobs.every((j) => j.order_item_id === null)).toBe(true)
    const cover = jobs.find((j) => j.role === 'cover')!
    const inner = jobs.find((j) => j.role === 'inner')!
    expect(cover.quantity).toBe(5) // 1 张/本 × 5 本
    expect(cover.mode_id).toBe(4)
    expect(inner.quantity).toBe(50) // 10 张/本 × 5 本
    expect(inner.mode_id).toBe(1)
    // Σ quoted_price === total（书行营收守恒，line_total 109）
    expect(jobs.reduce((s, j) => s + j.quoted_price, 0)).toBe(109)
  })

  it('折扣后 Σ(组件 quoted_price) === total 守恒', async () => {
    const id = await placeApprovedBookOrder()
    const admin = await login('staff@folioria.jp')
    const disc = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${id}/discount`,
      headers: { cookie: admin },
      payload: { discount: 10 },
    })
    expect((disc.json() as { total: number }).total).toBe(99)
    await app.inject({ method: 'PATCH', url: `/api/orders/${id}/status`, headers: { cookie: admin }, payload: { status: 'confirmed' } })
    const sum = (
      db
        .prepare(
          `SELECT COALESCE(SUM(j.quoted_price), 0) AS s
           FROM order_book_components obc JOIN jobs j ON j.id = obc.job_id
           WHERE obc.order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)`,
        )
        .get(id) as { s: number }
    ).s
    expect(sum).toBe(99)
  })

  it('AdminJobs 编组字段：GET /api/jobs 暴露 order_book_id/book_name/book_role', async () => {
    const id = await placeApprovedBookOrder()
    const admin = await login('staff@folioria.jp')
    await app.inject({ method: 'PATCH', url: `/api/orders/${id}/status`, headers: { cookie: admin }, payload: { status: 'confirmed' } })
    const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: admin } })
    const jobs = (res.json() as { data: Array<{ order_book_id: string | null; book_name: string | null; book_role: string | null }> }).data
    const bookJobs = jobs.filter((j) => j.order_book_id != null)
    expect(bookJobs).toHaveLength(2)
    expect(bookJobs.every((j) => j.book_name === '写真集')).toBe(true)
    expect(bookJobs.map((j) => j.book_role).sort()).toEqual(['cover', 'inner'])
  })

  it('confirmed 后 cancel：组件作业连带取消（queued → cancelled）', async () => {
    const id = await placeApprovedBookOrder()
    const admin = await login('staff@folioria.jp')
    await app.inject({ method: 'PATCH', url: `/api/orders/${id}/status`, headers: { cookie: admin }, payload: { status: 'confirmed' } })
    await app.inject({ method: 'PATCH', url: `/api/orders/${id}/status`, headers: { cookie: admin }, payload: { status: 'cancelled' } })
    const statuses = db
      .prepare(
        `SELECT j.status FROM order_book_components obc JOIN jobs j ON j.id = obc.job_id
         WHERE obc.order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)`,
      )
      .all(id) as Array<{ status: string }>
    expect(statuses).toHaveLength(2)
    expect(statuses.every((s) => s.status === 'cancelled')).toBe(true)
  })

  it('组件作业 done 落账：按组件 mode/paper/size/quantity 扣库存（completeJob 不变）', async () => {
    const id = await placeApprovedBookOrder(10, 5)
    const admin = await login('staff@folioria.jp')
    await app.inject({ method: 'PATCH', url: `/api/orders/${id}/status`, headers: { cookie: admin }, payload: { status: 'confirmed' } })
    // 给内页纸（paper 1 / A4）备 100 张账面
    db.prepare(
      "INSERT INTO paper_stocks (id, paper_id, size_key, quantity) VALUES ('st-inner', 1, 'A4', 100)",
    ).run()
    const innerJob = db
      .prepare(
        `SELECT j.id, j.quantity FROM order_book_components obc JOIN jobs j ON j.id = obc.job_id
         WHERE obc.role = 'inner' AND obc.order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)`,
      )
      .get(id) as { id: string; quantity: number }
    expect(innerJob.quantity).toBe(50)
    const done = await app.inject({
      method: 'POST',
      url: `/api/jobs/${innerJob.id}/done`,
      headers: { cookie: admin },
      payload: { waste_quantity: 0 },
    })
    expect(done.statusCode).toBe(200)
    expect((done.json() as { status: string }).status).toBe('done')
    const left = (db.prepare("SELECT quantity FROM paper_stocks WHERE id = 'st-inner'").get() as { quantity: number }).quantity
    expect(left).toBe(50) // 100 − 50
  })
})
