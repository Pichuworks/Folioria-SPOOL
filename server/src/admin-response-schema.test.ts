import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

// 契约硬化护栏（review T3）：管理域端点补 Fastify response schema 后，fast-json-stringify
// 按白名单序列化——漏列任一 handler 实际返回的字段即被静默 strip，前端拿不到数据。
// 本测试对每个端点把响应键集与「DB 行实际列（SELECT *）+ 已知计算字段」逐一比对，
// schema 漏列必触发缺键断言。键集源自 DB 列、独立于 schema 手写值，故能捕获遗漏。

let db: DB
let app: App
let adminCookie: string

beforeEach(async () => {
  db = makeTestDb()
  withSystemConfig(db)
  importSeed(db)
  createTestUser(db, { email: 'admin@t.jp', role: 'admin' })
  app = buildApp(db)
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@t.jp', password: 'test-password' },
  })
  adminCookie = `${SESSION_COOKIE}=${/spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1]}`
})
afterEach(async () => {
  await app.close()
  db.close()
})

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: adminCookie } })
const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload, headers: { cookie: adminCookie } })
const patch = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url, payload, headers: { cookie: adminCookie } })

/** SELECT * 行的实际列名（DB 真值，独立于 schema） */
function dbCols(sql: string, ...p: unknown[]): string[] {
  const row = db.prepare(sql).get(...p)
  if (!row) throw new Error(`dbCols: no row for ${sql}`)
  return Object.keys(row as object)
}

/** 断言 obj 含 expected 全部键（superset）——缺任一即 schema strip */
function expectKeys(obj: unknown, expected: string[], label: string): void {
  expect(obj && typeof obj === 'object', `${label}: not an object`).toBe(true)
  const have = new Set(Object.keys(obj as object))
  const missing = expected.filter((k) => !have.has(k))
  expect(missing, `${label}: stripped keys [${missing.join(', ')}]`).toEqual([])
}

/** 同尺寸下挑一台有库存的纸张库位并补货 */
async function makeStock(paperId: number, sizeKey: string, quantity: number): Promise<string> {
  const created = await post('/api/inventory/stocks', {
    paper_id: paperId,
    size_key: sizeKey,
    location_id: '3F纸张柜·A区',
  })
  expect(created.statusCode).toBe(201)
  const id = (created.json() as { id: string }).id
  if (quantity > 0) {
    const mv = await post(`/api/inventory/stocks/${id}/movements`, {
      action: 'purchase',
      quantity_delta: quantity,
    })
    expect(mv.statusCode).toBe(201)
  }
  return id
}

describe('jobs-routes response schema 不 strip', () => {
  it('GET/POST/PATCH/done 各端点键集 == handler 返回', async () => {
    await makeStock(1, 'A4', 500)

    // POST /api/jobs → 完整 jobs 行 + availability + availability_warning
    const created = await post('/api/jobs', {
      title: 'T1',
      mode_id: 1,
      paper_id: 1,
      size_key: 'A4',
      quantity: 200,
      quoted_price: 50000,
    })
    expect(created.statusCode).toBe(201)
    const job = created.json() as Record<string, unknown>
    const jobCols = dbCols('SELECT * FROM jobs WHERE id = ?', job['id'])
    expectKeys(job, [...jobCols, 'availability', 'availability_warning'], 'POST /api/jobs')
    expectKeys(
      job['availability'],
      ['paper_id', 'size_key', 'on_hand', 'reserved', 'available'],
      'POST /api/jobs .availability',
    )
    const jobId = job['id'] as string

    // PATCH :id/mode → jobs 行
    const reassigned = await patch(`/api/jobs/${jobId}/mode`, { mode_id: 1 })
    expect(reassigned.statusCode).toBe(200)
    expectKeys(reassigned.json(), jobCols, 'PATCH /api/jobs/:id/mode')

    // PATCH :id（字段编辑，draft 限定）→ jobs 行
    const edited = await patch(`/api/jobs/${jobId}`, { notes: 'edit' })
    expect(edited.statusCode).toBe(200)
    expectKeys(edited.json(), jobCols, 'PATCH /api/jobs/:id (field edit)')

    // PATCH :id（状态流转）→ jobs 行
    const queued = await patch(`/api/jobs/${jobId}`, { status: 'queued' })
    expect(queued.statusCode).toBe(200)
    expectKeys(queued.json(), jobCols, 'PATCH /api/jobs/:id (status)')

    // GET /api/jobs → { data:[jobs 行 + join/display], total }
    const list = await get('/api/jobs')
    expect(list.statusCode).toBe(200)
    const listBody = list.json() as { data: Array<Record<string, unknown>>; total: number }
    expectKeys(listBody, ['data', 'total'], 'GET /api/jobs envelope')
    const row = listBody.data.find((r) => r['id'] === jobId)
    expectKeys(
      row,
      [
        ...jobCols,
        'mode_name',
        'paper_name',
        'order_book_id',
        'book_name',
        'book_role',
        'total_cost_display',
        'profit_display',
        'quoted_price_display',
      ],
      'GET /api/jobs item',
    )

    // GET /api/jobs/board → 泳道 + 作业
    const board = await get('/api/jobs/board')
    expect(board.statusCode).toBe(200)
    const lanes = board.json() as Array<Record<string, unknown>>
    const lane = lanes.find((l) => Array.isArray(l['jobs']) && (l['jobs'] as unknown[]).length > 0)
    expectKeys(
      lane,
      ['printer_id', 'code', 'name', 'status', 'jobs', 'offline_with_jobs'],
      'GET /api/jobs/board lane',
    )
    expectKeys(
      (lane?.['jobs'] as Array<Record<string, unknown>>)[0],
      ['id', 'title', 'status', 'quantity', 'mode_name', 'paper_name', 'size_key', 'due_date'],
      'GET /api/jobs/board job',
    )

    // GET /api/jobs/availability
    const avail = await get('/api/jobs/availability?paper_id=1&size_key=A4')
    expect(avail.statusCode).toBe(200)
    expectKeys(
      avail.json(),
      ['paper_id', 'size_key', 'on_hand', 'reserved', 'available'],
      'GET /api/jobs/availability',
    )

    // GET /api/jobs/preview
    const preview = await get('/api/jobs/preview?mode_id=1&paper_id=1&size_key=A4&quantity=200')
    expect(preview.statusCode).toBe(200)
    expectKeys(
      preview.json(),
      [
        'ink_c',
        'paper_c',
        'overhead_c',
        'unit_total_c',
        'ink_display',
        'paper_display',
        'overhead_display',
        'unit_total_display',
        'est_total',
        'est_total_display',
        'paper_id',
        'size_key',
        'on_hand',
        'reserved',
        'available',
      ],
      'GET /api/jobs/preview',
    )

    // GET /api/jobs/recommend
    const rec = await get('/api/jobs/recommend?paper_id=1&size_key=A4')
    expect(rec.statusCode).toBe(200)
    const recs = rec.json() as Array<Record<string, unknown>>
    expect(recs.length).toBeGreaterThan(0)
    expectKeys(
      recs[0],
      [
        'mode_id',
        'mode_name',
        'printer_id',
        'printer_code',
        'printer_status',
        'unit_cost_c',
        'queue_pages',
        'unit_cost_display',
      ],
      'GET /api/jobs/recommend',
    )

    // POST :id/done → jobs 行（落账后）
    const done = await post(`/api/jobs/${jobId}/done`, { pages_consumed: 200 })
    expect(done.statusCode).toBe(200)
    expectKeys(done.json(), jobCols, 'POST /api/jobs/:id/done')
  })
})

describe('equipment-routes response schema 不 strip', () => {
  it('printers / maintenance 各端点键集 == handler 返回', async () => {
    const c850 = (db.prepare("SELECT id FROM printers WHERE code = 'C850'").get() as { id: number }).id
    const printerCols = dbCols('SELECT * FROM printers WHERE id = ?', c850)
    const printerExtra = ['calibration_due', 'equipment_cost_display', 'monthly_cost_display']

    const listed = await get('/api/equipment')
    expect(listed.statusCode).toBe(200)
    const rows = listed.json() as Array<Record<string, unknown>>
    expectKeys(
      rows.find((r) => r['code'] === 'C850'),
      [...printerCols, ...printerExtra],
      'GET /api/equipment item',
    )

    const one = await get(`/api/equipment/${c850}`)
    expect(one.statusCode).toBe(200)
    expectKeys(one.json(), [...printerCols, ...printerExtra], 'GET /api/equipment/:id')

    const patched = await patch(`/api/equipment/${c850}`, { status: 'standby' })
    expect(patched.statusCode).toBe(200)
    expectKeys(patched.json(), [...printerCols, ...printerExtra], 'PATCH /api/equipment/:id')

    // POST maintenance → 完整 maintenance_events 行
    const created = await post(`/api/equipment/${c850}/maintenance`, { type: 'nozzle_check', cost: 0 })
    expect(created.statusCode).toBe(201)
    const evtCols = dbCols('SELECT * FROM maintenance_events WHERE id = ?', (created.json() as { id: string }).id)
    expectKeys(created.json(), evtCols, 'POST /api/equipment/:id/maintenance')

    // GET maintenance → maintenance_events 行 + cost_display
    const events = await get(`/api/equipment/${c850}/maintenance`)
    expect(events.statusCode).toBe(200)
    const evRows = events.json() as Array<Record<string, unknown>>
    expectKeys(evRows[0], [...evtCols, 'cost_display'], 'GET /api/equipment/:id/maintenance')
  })
})

describe('inventory-routes response schema 不 strip', () => {
  it('locations / stocks / movements / consumables / log 键集 == handler 返回', async () => {
    // locations
    const loc = await post('/api/inventory/locations', { id: '2F暗房' })
    expect(loc.statusCode).toBe(201)
    const locCols = dbCols('SELECT * FROM locations WHERE id = ?', '2F暗房')
    expectKeys(loc.json(), locCols, 'POST /api/inventory/locations')

    const locPatched = await patch('/api/inventory/locations/2F暗房', { moisture_status: 'warning' })
    expect(locPatched.statusCode).toBe(200)
    expectKeys(locPatched.json(), locCols, 'PATCH /api/inventory/locations/:id')

    const locList = await get('/api/inventory/locations')
    expect(locList.statusCode).toBe(200)
    expectKeys((locList.json() as Array<unknown>)[0], locCols, 'GET /api/inventory/locations')

    // stocks
    const stockId = await makeStock(1, 'A4', 100)
    const stockCols = dbCols('SELECT * FROM paper_stocks WHERE id = ?', stockId)
    const stockCreated = await post('/api/inventory/stocks', { paper_id: 2, size_key: 'A4' })
    expect(stockCreated.statusCode).toBe(201)
    expectKeys(stockCreated.json(), stockCols, 'POST /api/inventory/stocks')

    const stockPatched = await patch(`/api/inventory/stocks/${stockId}`, { notes: 'n' })
    expect(stockPatched.statusCode).toBe(200)
    expectKeys(stockPatched.json(), stockCols, 'PATCH /api/inventory/stocks/:id')

    const stockList = await get('/api/inventory/stocks')
    expect(stockList.statusCode).toBe(200)
    expectKeys(
      (stockList.json() as Array<Record<string, unknown>>).find((r) => r['id'] === stockId),
      [...stockCols, 'paper_name', 'size_label', 'moisture_status'],
      'GET /api/inventory/stocks',
    )

    // movements → 完整 inventory_log 行
    const mv = await post(`/api/inventory/stocks/${stockId}/movements`, {
      action: 'consume',
      quantity_delta: -5,
      reason: 'r',
    })
    expect(mv.statusCode).toBe(201)
    const logCols = dbCols('SELECT * FROM inventory_log WHERE id = ?', (mv.json() as { id: string }).id)
    expectKeys(mv.json(), logCols, 'POST /api/inventory/stocks/:id/movements')

    // convert → { convert_group }
    const fromId = await makeStock(6, 'A3P', 50)
    const toId = await makeStock(6, 'A4', 0)
    const conv = await post('/api/inventory/convert', {
      from: { stock_id: fromId, quantity_delta: -10 },
      to: { stock_id: toId, quantity_delta: 20 },
    })
    expect(conv.statusCode).toBe(201)
    expectKeys(conv.json(), ['convert_group'], 'POST /api/inventory/convert')

    // consumables
    const c850 = (db.prepare("SELECT id FROM printers WHERE code = 'C850'").get() as { id: number }).id
    const consCreated = await post('/api/inventory/consumables', {
      name: 'Drum',
      type: 'drum',
      printer_id: c850,
      cost_model: 'per_page',
      rated_life_pages: 100000,
      unit_cost_c: 50000,
    })
    expect(consCreated.statusCode).toBe(201)
    const consId = (consCreated.json() as { id: string }).id
    const consCols = dbCols('SELECT * FROM consumables WHERE id = ?', consId)
    expectKeys(consCreated.json(), [...consCols, 'remaining_bp'], 'POST /api/inventory/consumables')

    const consPatched = await patch(`/api/inventory/consumables/${consId}`, { supplier: 's' })
    expect(consPatched.statusCode).toBe(200)
    expectKeys(consPatched.json(), consCols, 'PATCH /api/inventory/consumables/:id')

    const consList = await get('/api/inventory/consumables')
    expect(consList.statusCode).toBe(200)
    expectKeys(
      (consList.json() as Array<Record<string, unknown>>).find((r) => r['id'] === consId),
      [...consCols, 'printer_code', 'printer_name', 'remaining_bp', 'unit_cost_display'],
      'GET /api/inventory/consumables',
    )

    // log → { data:[inventory_log 行], total }
    const log = await get('/api/inventory/log')
    expect(log.statusCode).toBe(200)
    const logBody = log.json() as { data: Array<Record<string, unknown>>; total: number }
    expectKeys(logBody, ['data', 'total'], 'GET /api/inventory/log envelope')
    expectKeys(logBody.data[0], logCols, 'GET /api/inventory/log item')
  })
})

describe('reports-routes response schema 不 strip', () => {
  it('monthly / equipment-usage / paper-consumption / trend / snapshots 键集 == handler 返回', async () => {
    // 落一单 done 作业，使本月报表非空
    await makeStock(1, 'A4', 500)
    const created = await post('/api/jobs', {
      title: 'R1',
      mode_id: 1,
      paper_id: 1,
      size_key: 'A4',
      quantity: 100,
      quoted_price: 30000,
    })
    const jobId = (created.json() as { id: string }).id
    await patch(`/api/jobs/${jobId}`, { status: 'queued' })
    await post(`/api/jobs/${jobId}/done`, { pages_consumed: 100 })
    const month = new Date().toISOString().slice(0, 7)

    const monthly = await get('/api/reports/monthly')
    expect(monthly.statusCode).toBe(200)
    const mb = monthly.json() as Record<string, unknown>
    expectKeys(mb, ['month', 'jobs_done', 'pages', 'external', 'internal', 'writeoff'], 'monthly')
    expectKeys(
      mb['external'],
      ['jobs', 'revenue', 'cost', 'profit', 'revenue_display', 'cost_display', 'profit_display'],
      'monthly.external',
    )
    expectKeys(mb['internal'], ['jobs', 'cost', 'pages', 'cost_display'], 'monthly.internal')
    expectKeys(mb['writeoff'], ['jobs', 'cost', 'cost_display'], 'monthly.writeoff')

    const usage = await get('/api/reports/equipment-usage')
    expect(usage.statusCode).toBe(200)
    const ub = usage.json() as { month: string; printers: Array<Record<string, unknown>> }
    expectKeys(ub, ['month', 'printers'], 'equipment-usage envelope')
    expectKeys(
      ub.printers[0],
      ['id', 'code', 'name', 'status', 'total_pages', 'month_pages', 'month_jobs'],
      'equipment-usage printer',
    )

    const paper = await get('/api/reports/paper-consumption')
    expect(paper.statusCode).toBe(200)
    const pb = paper.json() as { month: string; rows: Array<Record<string, unknown>> }
    expectKeys(pb, ['month', 'rows'], 'paper-consumption envelope')
    expectKeys(pb.rows[0], ['paper_id', 'name', 'size_key', 'consumed', 'scrapped', 'total'], 'paper-consumption row')

    const trend = await get('/api/reports/trend')
    expect(trend.statusCode).toBe(200)
    const tb = trend.json() as Array<Record<string, unknown>>
    expectKeys(
      tb[0],
      ['month', 'revenue', 'cost', 'profit', 'internal_cost', 'revenue_display', 'cost_display', 'profit_display'],
      'trend item',
    )

    // snapshots：直接插一行 report_snapshots 保证非空
    db.prepare(
      `INSERT INTO report_snapshots (month, ext_revenue, ext_cost, ext_profit, int_cost, jobs_done, pages, payload, generated_at)
       VALUES (?, 1, 2, 3, 4, 5, 6, '{}', ?)`,
    ).run(month, new Date().toISOString())
    const snaps = await get('/api/reports/snapshots')
    expect(snaps.statusCode).toBe(200)
    const sb = snaps.json() as Array<Record<string, unknown>>
    expectKeys(
      sb[0],
      [
        'month',
        'ext_revenue',
        'ext_cost',
        'ext_profit',
        'int_cost',
        'jobs_done',
        'pages',
        'generated_at',
        'ext_revenue_display',
        'ext_cost_display',
        'ext_profit_display',
        'int_cost_display',
      ],
      'snapshots item',
    )
  })
})

describe('dashboard-routes response schema 不 strip', () => {
  it('GET /api/dashboard 键集 == handler 返回', async () => {
    // 插一条库存提醒使 inventory_alerts 非空
    db.prepare(
      `INSERT INTO alerts (id, type, severity, target_type, target_id, message, created_at)
       VALUES ('al1', 'low_stock', 'warning', 'paper_stock', 'x', 'm', '2026-06-10T00:00:00Z')`,
    ).run()
    const alertCols = dbCols("SELECT * FROM alerts WHERE id = 'al1'")

    const res = await get('/api/dashboard')
    expect(res.statusCode).toBe(200)
    const d = res.json() as Record<string, unknown>
    expectKeys(d, ['todo', 'inventory_alerts', 'monthly', 'equipment'], 'dashboard envelope')
    expectKeys(d['todo'], ['jobs_active', 'orders_active', 'maintenance_alerts'], 'dashboard.todo')
    expectKeys((d['inventory_alerts'] as Array<unknown>)[0], alertCols, 'dashboard.inventory_alerts item')
    expectKeys(
      d['monthly'],
      [
        'jobs_done',
        'revenue',
        'external_cost',
        'internal_cost',
        'profit',
        'pages',
        'revenue_display',
        'external_cost_display',
        'internal_cost_display',
        'profit_display',
      ],
      'dashboard.monthly',
    )
    expectKeys(
      (d['equipment'] as Array<Record<string, unknown>>)[0],
      ['code', 'name', 'status', 'total_pages', 'calibration_due'],
      'dashboard.equipment item',
    )
  })
})
