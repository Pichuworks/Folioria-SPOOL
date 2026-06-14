import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

/**
 * PB4 书作业核算校验：dashboard / 月度报表正确计入书组件作业（quoted_price 营收 / done 成本快照）。
 * 书组件作业 order_item_id 为 NULL → 不 join 到 orders；凭 quoted_price 非空归外部营收（与单页 item 同口径），
 * 内外口径（quoted_price IS NULL = 内部工坊消耗）不被书行破坏。
 */

let db: DB
let app: App
let bookId: number
let innerId: number

const month = new Date().toISOString().slice(0, 7)

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

  // 封面 color·paper6·A3（→mode4）+ 内页 bw·paper1·A4（→mode1），无工艺以保持口径清晰
  bookId = Number(db.prepare("INSERT INTO book_products (name) VALUES ('写真集')").run().lastInsertRowid)
  db.prepare(
    "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'cover', 6, 'A3', 'color', 0, 0)",
  ).run(bookId)
  innerId = Number(
    db
      .prepare(
        "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'inner', 1, 'A4', 'bw', 0, 1)",
      )
      .run(bookId).lastInsertRowid,
  )
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

/** 下单（customer 外部）→ 审稿过 → confirm → 备料 → 两组件作业 done。返回 order id + admin cookie */
async function bookOrderWithDoneComponents(innerSheets = 10, count = 5): Promise<{ id: string; admin: string }> {
  const cust = await login('a@cust.example')
  const created = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie: cust },
    payload: { books: [{ book_id: bookId, count, components: [{ component_id: innerId, sheets_per_book: innerSheets }] }] },
  })
  const id = (created.json() as { id: string }).id
  // 推进到 file_approved（PB1 文件门）
  db.prepare(
    `UPDATE order_book_components SET file_url = 'seed.pdf', file_status = 'approved'
     WHERE order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)`,
  ).run(id)
  db.prepare("UPDATE orders SET status = 'file_approved' WHERE id = ?").run(id)

  const admin = await login('staff@folioria.jp')
  await app.inject({ method: 'PATCH', url: `/api/orders/${id}/status`, headers: { cookie: admin }, payload: { status: 'confirmed' } })

  // 两组件纸×尺寸备料（封面 paper6/A3、内页 paper1/A4）
  db.prepare(
    "INSERT INTO paper_stocks (id, paper_id, size_key, quantity) VALUES ('st-cover', 6, 'A3', 1000), ('st-inner', 1, 'A4', 1000)",
  ).run()

  const jobIds = (
    db
      .prepare(
        `SELECT j.id FROM order_book_components obc JOIN jobs j ON j.id = obc.job_id
         WHERE obc.order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)`,
      )
      .all(id) as Array<{ id: string }>
  ).map((r) => r.id)
  for (const jid of jobIds) {
    const done = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/done`, headers: { cookie: admin }, payload: { waste_quantity: 0 } })
    expect(done.statusCode).toBe(200)
  }
  return { id, admin }
}

describe('PB4 书作业核算：月度报表', () => {
  it('外部书单组件 done 计入 external revenue/cost/profit（Σ quoted === 书行 line_total）', async () => {
    const { id, admin } = await bookOrderWithDoneComponents()

    // 期望从 done 作业快照派生（不硬编码 seed 价格）
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(quoted_price),0) AS rev, COALESCE(SUM(total_cost),0) AS cost,
                COALESCE(SUM(profit),0) AS profit, COALESCE(SUM(pages_consumed),0) AS pages
         FROM jobs WHERE status = 'done'`,
      )
      .get() as { n: number; rev: number; cost: number; profit: number; pages: number }
    const orderTotal = (db.prepare('SELECT total FROM orders WHERE id = ?').get(id) as { total: number }).total
    expect(agg.n).toBe(2)
    expect(agg.rev).toBe(orderTotal) // 无折扣：Σ组件营收 = 书行 line_total = 订单 total

    const monthly = (
      await app.inject({ method: 'GET', url: `/api/reports/monthly?month=${month}`, headers: { cookie: admin } })
    ).json() as {
      jobs_done: number
      pages: number
      external: { jobs: number; revenue: number; cost: number; profit: number }
      internal: { jobs: number; cost: number }
    }
    expect(monthly.jobs_done).toBe(2)
    expect(monthly.pages).toBe(agg.pages)
    expect(monthly.external).toMatchObject({ jobs: 2, revenue: agg.rev, cost: agg.cost, profit: agg.profit })
    expect(monthly.internal).toMatchObject({ jobs: 0, cost: 0 }) // 书行不漏入内部桶
  })

  it('dashboard 月度宫格计入书组件作业（revenue/profit/jobs_done）', async () => {
    const { id, admin } = await bookOrderWithDoneComponents()
    const agg = db
      .prepare("SELECT COALESCE(SUM(quoted_price),0) AS rev, COALESCE(SUM(profit),0) AS profit FROM jobs WHERE status = 'done'")
      .get() as { rev: number; profit: number }
    const orderTotal = (db.prepare('SELECT total FROM orders WHERE id = ?').get(id) as { total: number }).total

    const dash = (await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: admin } })).json() as {
      monthly: { jobs_done: number; revenue: number; profit: number; internal_cost: number }
    }
    expect(dash.monthly.jobs_done).toBe(2)
    expect(dash.monthly.revenue).toBe(orderTotal)
    expect(dash.monthly.revenue).toBe(agg.rev)
    expect(dash.monthly.profit).toBe(agg.profit)
    expect(dash.monthly.internal_cost).toBe(0)
  })

  it('内外口径不被书行破坏：纯工坊内部作业(quoted NULL)单列 internal，书组件留 external', async () => {
    const { admin } = await bookOrderWithDoneComponents()

    // 纯内部工坊作业（无订单关联，quoted_price NULL）：draft → queued → printing → done
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { cookie: admin },
        payload: { title: '内部测试卡', mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 30, quoted_price: null },
      })
    ).json() as { id: string }
    for (const s of ['queued', 'printing'] as const) {
      await app.inject({ method: 'PATCH', url: `/api/jobs/${created.id}`, headers: { cookie: admin }, payload: { status: s } })
    }
    await app.inject({ method: 'POST', url: `/api/jobs/${created.id}/done`, headers: { cookie: admin }, payload: { waste_quantity: 0 } })

    const monthly = (
      await app.inject({ method: 'GET', url: `/api/reports/monthly?month=${month}`, headers: { cookie: admin } })
    ).json() as {
      jobs_done: number
      external: { jobs: number }
      internal: { jobs: number; cost: number }
    }
    expect(monthly.jobs_done).toBe(3) // 2 书组件 + 1 内部
    expect(monthly.external.jobs).toBe(2) // 仅书组件，凭 quoted_price 归外部
    expect(monthly.internal.jobs).toBe(1) // 工坊内部，quoted_price NULL
    expect(monthly.internal.cost).toBeGreaterThan(0)
  })
})
