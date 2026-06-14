import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { collectForbiddenKeys, createTestUser, makeTestDb } from './test-helpers.js'

/** D27 书成品/组件/工艺 管理域 CRUD + 下单域目录/实时报价（机器对客户不可见）。 */

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

/** admin 经 API 搭一本带封面+内页+两道工艺的书，返回 ids */
async function buildBook(admin: string): Promise<{ book: number; cover: number; inner: number; bind: number; num: number }> {
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { cookie: admin }, payload })
  const book = (await post('/api/pricing/books', { name: '写真集' })).json() as { id: number }
  const cover = (await post(`/api/pricing/books/${book.id}/components`, { role: 'cover', paper_id: 6, size_key: 'A3', color_class: 'color' })).json() as { id: number }
  const inner = (await post(`/api/pricing/books/${book.id}/components`, { role: 'inner', paper_id: 1, size_key: 'A4', color_class: 'bw', sort: 1 })).json() as { id: number }
  const bind = (await post('/api/pricing/finishings', { name: '骑马钉', pricing: 'per_book', price_c: 2000 })).json() as { id: number }
  const num = (await post('/api/pricing/finishings', { name: '页码', pricing: 'per_page', price_c: 3 })).json() as { id: number }
  await app.inject({ method: 'PUT', url: `/api/pricing/books/${book.id}/finishings/${bind.id}`, headers: { cookie: admin } })
  await app.inject({ method: 'PUT', url: `/api/pricing/books/${book.id}/finishings/${num.id}`, headers: { cookie: admin } })
  return { book: book.id, cover: cover.id, inner: inner.id, bind: bind.id, num: num.id }
}

describe('管理域 CRUD', () => {
  it('建书 + 组件 + 工艺挂接 → GET /api/pricing/books 汇总', async () => {
    const admin = await login('staff@folioria.jp')
    const ids = await buildBook(admin)
    const res = await app.inject({ method: 'GET', url: '/api/pricing/books', headers: { cookie: admin } })
    const books = res.json() as Array<{ id: number; components: unknown[]; finishing_ids: number[] }>
    const book = books.find((b) => b.id === ids.book)!
    expect(book.components).toHaveLength(2)
    expect(book.finishing_ids.sort()).toEqual([ids.bind, ids.num].sort())
  })

  it('组件未知纸/尺寸 → 409；归档组件后目录不再含它', async () => {
    const admin = await login('staff@folioria.jp')
    const ids = await buildBook(admin)
    const bad = await app.inject({
      method: 'POST',
      url: `/api/pricing/books/${ids.book}/components`,
      headers: { cookie: admin },
      payload: { role: 'insert', paper_id: 999, size_key: 'A4', color_class: 'color' },
    })
    expect(bad.statusCode).toBe(409)
    const del = await app.inject({ method: 'DELETE', url: `/api/pricing/book-components/${ids.cover}`, headers: { cookie: admin } })
    expect(del.statusCode).toBe(204)
    const cat = await app.inject({ method: 'GET', url: '/api/calculator/books' })
    const book = (cat.json() as { books: Array<{ id: number; components: unknown[] }> }).books.find((b) => b.id === ids.book)!
    expect(book.components).toHaveLength(1) // 仅内页（封面已归档）
  })

  it('下单域无权访问管理 CRUD：customer POST /api/pricing/books → 403', async () => {
    const cust = await login('a@cust.example')
    const res = await app.inject({ method: 'POST', url: '/api/pricing/books', headers: { cookie: cust }, payload: { name: 'x' } })
    expect(res.statusCode).toBe(403)
  })
})

describe('下单域目录 / 实时报价（机器不可见）', () => {
  it('GET /api/calculator/books：组件无 mode_id；工艺带 price_display；§6 无 cost/profit/margin', async () => {
    const admin = await login('staff@folioria.jp')
    await buildBook(admin)
    const res = await app.inject({ method: 'GET', url: '/api/calculator/books' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { books: Array<{ components: Array<Record<string, unknown>>; finishings: Array<Record<string, unknown>> }> }
    const book = body.books[0]!
    for (const c of book.components) expect(c).not.toHaveProperty('mode_id')
    expect(book.finishings[0]).toHaveProperty('price_display')
    expect(collectForbiddenKeys(body)).toEqual([])
  })

  it('POST /api/calculator/book-quote：unit 2191 / line_total 110；组件无 mode_id；工艺贡献 [2000,33]', async () => {
    const admin = await login('staff@folioria.jp')
    const ids = await buildBook(admin)
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
    expect(q.unit_price_c).toBe(2191)
    expect(q.line_total).toBe(110)
    for (const c of q.components) expect(c).not.toHaveProperty('mode_id')
    expect(q.finishings.map((f) => f.contribution_c).sort((a, b) => a - b)).toEqual([33, 2000])
    expect(collectForbiddenKeys(q)).toEqual([])
  })

  it('内页缺张数 → 422', async () => {
    const admin = await login('staff@folioria.jp')
    const ids = await buildBook(admin)
    const res = await app.inject({
      method: 'POST',
      url: '/api/calculator/book-quote',
      payload: { book_id: ids.book, count: 1, components: [] },
    })
    expect(res.statusCode).toBe(422)
  })

  it('member 实时报价走内部价口径（internal_sell 覆盖生效）', async () => {
    const admin = await login('staff@folioria.jp')
    const ids = await buildBook(admin)
    // 内页 combo（mode1×paper1）A4 内部价压到 5
    db.prepare("UPDATE combo_prices SET internal_sell_c = 5 WHERE combo_id = 1 AND size_key = 'A4'").run()
    const member = await login('m@member.example')
    const res = await app.inject({
      method: 'POST',
      url: '/api/calculator/book-quote',
      headers: { cookie: member },
      payload: { book_id: ids.book, count: 1, components: [{ component_id: ids.inner, sheets_per_book: 10 }] },
    })
    const q = res.json() as { unit_price_c: number }
    // 封面 88 + 内页 5×10=50 + per_book 2000 + per_page 3×11=33 = 2171（对外为 2191）
    expect(q.unit_price_c).toBe(2171)
  })
})
