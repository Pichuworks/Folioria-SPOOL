import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { collectForbiddenKeys, createTestUser, makeTestDb } from './test-helpers.js'

/** D27 书成品 — 管理域 CRUD 已移除（客户下单时自由组合），仅保留 calculator 路由测试。 */

let db: DB
let app: App
beforeEach(() => {
  db = makeTestDb()
  spoolInit(db, { baseCurrency: 'JPY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'initial-secret-pw' })
  importSeed(db)
  createTestUser(db, { email: 'a@cust.example' })
  createTestUser(db, { email: 'staff@folioria.jp', role: 'admin' })
  createTestUser(db, { email: 'm@member.example', role: 'member' })
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

/** 直接 DB 插入搭一本带封面+内页+两道工艺的书 */
function buildBook(): { book: number; cover: number; inner: number; bind: number; num: number } {
  const bookId = Number(db.prepare("INSERT INTO book_products (name) VALUES ('写真集')").run().lastInsertRowid)
  const coverId = Number(
    db.prepare(
      "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'cover', 6, 'A3', 'color', 0, 0)",
    ).run(bookId).lastInsertRowid,
  )
  const innerId = Number(
    db.prepare(
      "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'inner', 1, 'A4', 'bw', 0, 1)",
    ).run(bookId).lastInsertRowid,
  )
  const bindId = Number(
    db.prepare("INSERT INTO finishing_ops (name, pricing, price_c) VALUES ('骑马钉', 'per_book', 2000)").run().lastInsertRowid,
  )
  const numId = Number(
    db.prepare("INSERT INTO finishing_ops (name, pricing, price_c) VALUES ('页码', 'per_page', 3)").run().lastInsertRowid,
  )
  db.prepare('INSERT INTO book_finishings (book_id, finishing_id) VALUES (?, ?)').run(bookId, bindId)
  db.prepare('INSERT INTO book_finishings (book_id, finishing_id) VALUES (?, ?)').run(bookId, numId)
  return { book: bookId, cover: coverId, inner: innerId, bind: bindId, num: numId }
}

describe('下单域目录 / 实时报价（机器不可见）', () => {
  it('GET /api/calculator/books：组件无 mode_id；工艺带 price_display；§6 无 cost/profit/margin', async () => {
    buildBook()
    const res = await app.inject({ method: 'GET', url: '/api/calculator/books' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { books: Array<{ components: Array<Record<string, unknown>>; finishings: Array<Record<string, unknown>> }> }
    const book = body.books[0]!
    for (const c of book.components) expect(c).not.toHaveProperty('mode_id')
    expect(book.finishings[0]).toHaveProperty('price_display')
    expect(collectForbiddenKeys(body)).toEqual([])
  })

  it('POST /api/calculator/book-quote：unit 17346 / line_total 867；组件无 mode_id；工艺贡献 [2000,33]', async () => {
    const ids = buildBook()
    const res = await app.inject({
      method: 'POST',
      url: '/api/calculator/book-quote',
      payload: { book_id: ids.book, count: 5, components: [{ component_id: ids.inner, sheets_per_book: 10 }] },
    })
    expect(res.statusCode).toBe(200)
    const q = res.json() as {
      unit_price_c: number
      line_total: number
      components: Array<Record<string, unknown>>
      finishings: Array<{ contribution_c: number }>
    }
    expect(q.unit_price_c).toBe(17346)
    expect(q.line_total).toBe(867)
    for (const c of q.components) expect(c).not.toHaveProperty('mode_id')
    expect(q.finishings.map((f) => f.contribution_c).sort((a, b) => a - b)).toEqual([33, 2000])
    expect(collectForbiddenKeys(q)).toEqual([])
  })

  it('内页缺张数 → 422', async () => {
    const ids = buildBook()
    const res = await app.inject({
      method: 'POST',
      url: '/api/calculator/book-quote',
      payload: { book_id: ids.book, count: 1, components: [] },
    })
    expect(res.statusCode).toBe(422)
  })

  it('member 实时报价走内部价口径（internal_sell 覆盖生效）', async () => {
    const ids = buildBook()
    db.prepare("UPDATE combo_prices SET internal_sell_c = 500 WHERE combo_id = 1 AND size_key = 'A4'").run()
    const member = await login('m@member.example')
    const res = await app.inject({
      method: 'POST',
      url: '/api/calculator/book-quote',
      headers: { cookie: member },
      payload: { book_id: ids.book, count: 1, components: [{ component_id: ids.inner, sheets_per_book: 10 }] },
    })
    const q = res.json() as { unit_price_c: number }
    expect(q.unit_price_c).toBe(15346)
  })
})
