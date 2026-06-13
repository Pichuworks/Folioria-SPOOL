import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

let db: DB
let app: App
let adminCookie: string
let memberCookie: string
let adminId: string

beforeEach(async () => {
  db = makeTestDb()
  withSystemConfig(db)
  importSeed(db)
  adminId = createTestUser(db, { email: 'admin@t.jp', role: 'admin' })
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

const get = async (url: string) => await app.inject({ method: 'GET', url, headers: { cookie: adminCookie } })

function insertDoneJob(opts: {
  quoted: number | null
  cost: number
  profit?: number | null
  pages: number
  completedAt: string
  modeId?: number
}): void {
  db.prepare(
    `INSERT INTO jobs (id, requester_id, title, mode_id, paper_id, size_key, quantity,
                       pages_consumed, total_cost, quoted_price, profit, status, created_at, completed_at)
     VALUES (?, ?, 'job', ?, 1, 'A4', 100, ?, ?, ?, ?, 'done', ?, ?)`,
  ).run(
    randomUUID(),
    adminId,
    opts.modeId ?? 1,
    opts.pages,
    opts.cost,
    opts.quoted,
    opts.profit ?? null,
    opts.completedAt,
    opts.completedAt,
  )
}

describe('F2 /api/reports 管理域守卫', () => {
  it.each(['monthly', 'equipment-usage', 'paper-consumption'])('%s: guest 401 / member 403', async (name) => {
    expect((await app.inject({ method: 'GET', url: `/api/reports/${name}` })).statusCode).toBe(401)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/reports/${name}`,
          headers: { cookie: memberCookie },
        })
      ).statusCode,
    ).toBe(403)
  })

  it('month 参数格式非 YYYY-MM → 422', async () => {
    expect((await get('/api/reports/monthly?month=2026-6')).statusCode).toBe(422)
    expect((await get('/api/reports/monthly?month=junk')).statusCode).toBe(422)
  })
})

describe('F2 monthly（内部消耗单列）', () => {
  it('外部收入/成本/毛利与内部消耗分列；非本月 job 不计', async () => {
    insertDoneJob({ quoted: 500, cost: 200, profit: 300, pages: 100, completedAt: '2026-06-05T10:00:00Z' })
    insertDoneJob({ quoted: null, cost: 80, pages: 40, completedAt: '2026-06-07T10:00:00Z' })
    insertDoneJob({ quoted: 999, cost: 1, profit: 998, pages: 9, completedAt: '2026-05-20T10:00:00Z' })

    const res = await get('/api/reports/monthly?month=2026-06')
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      month: string
      jobs_done: number
      pages: number
      external: { jobs: number; revenue: number; cost: number; profit: number; revenue_display: string }
      internal: { jobs: number; cost: number; pages: number; cost_display: string }
    }
    expect(body.month).toBe('2026-06')
    expect(body.jobs_done).toBe(2)
    expect(body.pages).toBe(140)
    expect(body.external).toMatchObject({ jobs: 1, revenue: 500, cost: 200, profit: 300 })
    expect(body.external.revenue_display).toBe('¥500')
    expect(body.internal).toMatchObject({ jobs: 1, cost: 80, pages: 40 })
    expect(body.internal.cost_display).toBe('¥80')
  })

  it('cancelled 订单下的 done 作业不计入 ext_revenue，单列 writeoff', async () => {
    insertDoneJob({ quoted: 500, cost: 200, profit: 300, pages: 100, completedAt: '2026-06-05T10:00:00Z' })

    const orderId = randomUUID()
    const itemId = randomUUID()
    db.prepare(
      `INSERT INTO orders (id, order_number, access_token, customer_id, subtotal, discount, total,
                           status, quote_valid_until, created_at, completed_at)
       VALUES (?, 'FOL-2026-9999', ?, ?, 200, 0, 200, 'cancelled',
               '2099-01-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-04T00:00:00Z')`,
    ).run(orderId, randomUUID(), adminId)
    db.prepare(
      `INSERT INTO order_items (id, order_id, mode_id, paper_id, size_key, quantity, unit_price_c, line_total)
       VALUES (?, ?, 1, 1, 'A4', 100, 20, 200)`,
    ).run(itemId, orderId)
    db.prepare(
      `INSERT INTO jobs (id, order_item_id, requester_id, title, mode_id, paper_id, size_key, quantity,
                         pages_consumed, total_cost, quoted_price, profit, status, created_at, completed_at)
       VALUES (?, ?, ?, 'writeoff-job', 1, 1, 'A4', 100, 80, 50, 200, 150, 'done', ?, ?)`,
    ).run(randomUUID(), itemId, adminId, '2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z')

    const res = await get('/api/reports/monthly?month=2026-06')
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      jobs_done: number
      external: { jobs: number; revenue: number; cost: number; profit: number }
      writeoff: { jobs: number; cost: number; cost_display: string }
    }
    expect(body.jobs_done).toBe(2)
    expect(body.external).toMatchObject({ jobs: 1, revenue: 500, cost: 200, profit: 300 })
    expect(body.writeoff).toMatchObject({ jobs: 1, cost: 50 })
    expect(body.writeoff.cost_display).toBe('¥50')
  })

  it('空月份全零（不报错）', async () => {
    const res = await get('/api/reports/monthly?month=2031-01')
    expect(res.statusCode).toBe(200)
    const body = res.json() as { jobs_done: number; external: { revenue: number }; writeoff: { jobs: number; cost: number } }
    expect(body.jobs_done).toBe(0)
    expect(body.external.revenue).toBe(0)
    expect(body.writeoff).toMatchObject({ jobs: 0, cost: 0 })
  })
})

describe('F2 equipment-usage（设备利用率）', () => {
  it('按 mode→printer 归集本月页数与作业数；无作业设备计零', async () => {
    insertDoneJob({ quoted: 500, cost: 200, pages: 100, completedAt: '2026-06-05T10:00:00Z', modeId: 1 })
    insertDoneJob({ quoted: null, cost: 80, pages: 40, completedAt: '2026-06-07T10:00:00Z', modeId: 1 })

    const printerOfMode1 = (
      db.prepare('SELECT printer_id FROM print_modes WHERE id = 1').get() as { printer_id: number }
    ).printer_id

    const res = await get('/api/reports/equipment-usage?month=2026-06')
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      month: string
      printers: Array<{ id: number; code: string; total_pages: number; month_pages: number; month_jobs: number }>
    }
    const used = body.printers.find((p) => p.id === printerOfMode1)
    expect(used?.month_pages).toBe(140)
    expect(used?.month_jobs).toBe(2)

    const idle = body.printers.filter((p) => p.id !== printerOfMode1)
    expect(idle.length).toBeGreaterThan(0)
    for (const p of idle) {
      expect(p.month_pages).toBe(0)
      expect(p.month_jobs).toBe(0)
    }
    // 全设备在列，含档案累计页数
    const dbPrinters = db.prepare('SELECT id, total_pages FROM printers WHERE archived = 0').all() as Array<{
      id: number
      total_pages: number
    }>
    expect(body.printers.length).toBe(dbPrinters.length)
    for (const dp of dbPrinters) {
      expect(body.printers.find((p) => p.id === dp.id)?.total_pages).toBe(dp.total_pages)
    }
  })
})

describe('F2 paper-consumption（纸张消耗排行）', () => {
  it('consume+scrap 计入、purchase 不计、按总量降序、跨月不计', async () => {
    db.prepare(
      "INSERT INTO paper_stocks (id, paper_id, size_key, quantity) VALUES ('ps-1', 1, 'A4', 1000), ('ps-2', 6, 'A3P', 500)",
    ).run()
    const log = db.prepare(
      `INSERT INTO inventory_log (id, target_type, target_id, action, quantity_delta, created_at)
       VALUES (?, 'paper_stock', ?, ?, ?, ?)`,
    )
    log.run(randomUUID(), 'ps-1', 'consume', -200, '2026-06-03T00:00:00Z')
    log.run(randomUUID(), 'ps-1', 'scrap', -3, '2026-06-03T00:00:00Z')
    log.run(randomUUID(), 'ps-2', 'consume', -50, '2026-06-04T00:00:00Z')
    log.run(randomUUID(), 'ps-1', 'purchase', 500, '2026-06-05T00:00:00Z')
    log.run(randomUUID(), 'ps-1', 'consume', -999, '2026-05-01T00:00:00Z')

    const res = await get('/api/reports/paper-consumption?month=2026-06')
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      month: string
      rows: Array<{ paper_id: number; name: string; size_key: string; consumed: number; scrapped: number; total: number }>
    }
    expect(body.rows.length).toBe(2)
    expect(body.rows[0]).toMatchObject({ paper_id: 1, size_key: 'A4', consumed: 200, scrapped: 3, total: 203 })
    expect(body.rows[1]).toMatchObject({ paper_id: 6, size_key: 'A3P', consumed: 50, scrapped: 0, total: 50 })
    const paper1Name = (db.prepare('SELECT name FROM papers WHERE id = 1').get() as { name: string }).name
    expect(body.rows[0]?.name).toBe(paper1Name)
  })
})
