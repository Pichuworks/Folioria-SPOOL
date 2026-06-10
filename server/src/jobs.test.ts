import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

let db: DB
let app: App
let adminCookie: string
let stockId: string

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

  stockId = 'stock-a4'
  db.prepare(
    `INSERT INTO paper_stocks (id, paper_id, size_key, quantity, location_id)
     VALUES (?, 1, 'A4', 500, NULL)`,
  ).run(stockId)
})
afterEach(async () => {
  await app.close()
  db.close()
})

const post = async (url: string, payload: Record<string, unknown>) =>
  await app.inject({ method: 'POST', url, payload, headers: { cookie: adminCookie } })
const patch = async (url: string, payload: Record<string, unknown>) =>
  await app.inject({ method: 'PATCH', url, payload, headers: { cookie: adminCookie } })

async function makeJob(quantity: number, quotedPrice?: number): Promise<string> {
  const res = await post('/api/jobs', {
    title: '测试作业',
    mode_id: 1,
    paper_id: 1,
    size_key: 'A4',
    quantity,
    ...(quotedPrice === undefined ? {} : { quoted_price: quotedPrice }),
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

const snapshot = () => ({
  stock: db.prepare('SELECT quantity FROM paper_stocks WHERE id = ?').get(stockId),
  logs: (db.prepare('SELECT COUNT(*) n FROM inventory_log').get() as { n: number }).n,
  usage: db.prepare('SELECT current_usage_pages FROM consumables LIMIT 1').get(),
  pages: db.prepare("SELECT total_pages FROM printers WHERE code = 'C850'").get(),
})

describe('§3.1 done 落账（单事务）', () => {
  it('打印 200 + 废品 3：库存 −203、双日志、耗材 +203、计数器 +203、成本快照定格', async () => {
    const jobId = await makeJob(200, 14)
    await patch(`/api/jobs/${jobId}`, { status: 'queued' })
    await patch(`/api/jobs/${jobId}`, { status: 'printing' })

    const done = await post(`/api/jobs/${jobId}/done`, { waste_quantity: 3 })
    expect(done.statusCode).toBe(200)

    expect((db.prepare('SELECT quantity FROM paper_stocks WHERE id = ?').get(stockId) as { quantity: number }).quantity).toBe(297)

    const logs = db
      .prepare("SELECT action, quantity_delta, related_job_id FROM inventory_log WHERE target_id = ? ORDER BY quantity_delta DESC")
      .all(stockId) as Array<{ action: string; quantity_delta: number; related_job_id: string | null }>
    expect(logs.length).toBe(2)
    expect(logs.map((l) => [l.action, l.quantity_delta])).toEqual([
      ['scrap', -3],
      ['consume', -200],
    ])
    expect(logs.every((l) => l.related_job_id === jobId)).toBe(true)

    const usage = db.prepare('SELECT current_usage_pages FROM consumables LIMIT 1').get() as {
      current_usage_pages: number
    }
    expect(usage.current_usage_pages).toBe(203)

    const printer = db.prepare("SELECT total_pages FROM printers WHERE code = 'C850'").get() as {
      total_pages: number
    }
    expect(printer.total_pages).toBe(203)

    // 成本快照：ink 3 + paper 3 + overhead 29 = 35_c/张；total = round(35×203/100) = 71；profit = 14 − 71
    const job = db
      .prepare(
        'SELECT status, waste_quantity, pages_consumed, paper_cost_c, consumable_cost_c, overhead_cost_c, total_cost, profit, completed_at FROM jobs WHERE id = ?',
      )
      .get(jobId) as Record<string, unknown>
    expect(job['status']).toBe('done')
    expect(job['waste_quantity']).toBe(3)
    expect(job['pages_consumed']).toBe(203)
    expect(job['paper_cost_c']).toBe(3)
    expect(job['consumable_cost_c']).toBe(3)
    expect(job['overhead_cost_c']).toBe(29)
    expect(job['total_cost']).toBe(71)
    expect(job['profit']).toBe(14 - 71)
    expect(job['completed_at']).not.toBeNull()
  })

  it('事务中途失败 → 全部回滚，无半账（触发器强制 printer 更新失败）', async () => {
    const jobId = await makeJob(200)
    await patch(`/api/jobs/${jobId}`, { status: 'queued' })
    const before = snapshot()

    db.exec(
      "CREATE TRIGGER boom BEFORE UPDATE OF total_pages ON printers BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    const done = await post(`/api/jobs/${jobId}/done`, { waste_quantity: 3 })
    expect(done.statusCode).toBe(500)
    db.exec('DROP TRIGGER boom')

    expect(snapshot()).toEqual(before)
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string }
    expect(job.status).toBe('queued')
  })

  it('done 后 cancelled/再 done 均拒绝（状态机）', async () => {
    const jobId = await makeJob(10)
    await patch(`/api/jobs/${jobId}`, { status: 'queued' })
    await post(`/api/jobs/${jobId}/done`, {})
    expect((await post(`/api/jobs/${jobId}/done`, {})).statusCode).toBe(409)
    expect((await patch(`/api/jobs/${jobId}`, { status: 'cancelled' })).statusCode).toBe(409)
  })
})

describe('§3.2 cancelled 零动作', () => {
  it('queued → cancelled：库存/日志/耗材/计数器全部无变化', async () => {
    const jobId = await makeJob(50)
    await patch(`/api/jobs/${jobId}`, { status: 'queued' })
    const before = snapshot()

    const res = await patch(`/api/jobs/${jobId}`, { status: 'cancelled' })
    expect(res.statusCode).toBe(200)
    expect(snapshot()).toEqual(before)
    expect(
      (db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string }).status,
    ).toBe('cancelled')
  })
})

describe('§3.3 可用量动态计算（纯查询，零写入）', () => {
  it('账面 48，queued 20+10 → available 18；cancel 其一 → 28', async () => {
    db.prepare('UPDATE paper_stocks SET quantity = 48 WHERE id = ?').run(stockId)

    const j1 = await makeJob(20)
    const j2 = await makeJob(10)
    await patch(`/api/jobs/${j1}`, { status: 'queued' })
    await patch(`/api/jobs/${j2}`, { status: 'queued' })

    const logCountBefore = (db.prepare('SELECT COUNT(*) n FROM inventory_log').get() as { n: number }).n

    const avail = await app.inject({
      method: 'GET',
      url: '/api/jobs/availability?paper_id=1&size_key=A4',
      headers: { cookie: adminCookie },
    })
    expect(avail.statusCode).toBe(200)
    expect(avail.json()).toEqual({ paper_id: 1, size_key: 'A4', on_hand: 48, reserved: 30, available: 18 })

    await patch(`/api/jobs/${j2}`, { status: 'cancelled' })
    const after = await app.inject({
      method: 'GET',
      url: '/api/jobs/availability?paper_id=1&size_key=A4',
      headers: { cookie: adminCookie },
    })
    expect((after.json() as { available: number }).available).toBe(28)

    expect((db.prepare('SELECT COUNT(*) n FROM inventory_log').get() as { n: number }).n).toBe(logCountBefore)
  })

  it('不足时警告但不阻断（admin 可强排）：queued 超过账面仍可创建', async () => {
    db.prepare('UPDATE paper_stocks SET quantity = 5 WHERE id = ?').run(stockId)
    const res = await post('/api/jobs', {
      title: '强排',
      mode_id: 1,
      paper_id: 1,
      size_key: 'A4',
      quantity: 100,
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as { availability_warning: boolean }).availability_warning).toBe(true)
  })
})

describe('作业其他', () => {
  it('成本预览（管理域）：单价层快照与可用量', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs/preview?mode_id=1&paper_id=1&size_key=A4&quantity=200',
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body['ink_c']).toBe(3)
    expect(body['paper_c']).toBe(3)
    expect(body['overhead_c']).toBe(29)
    expect(body['unit_total_c']).toBe(35)
    expect(body['on_hand']).toBe(500)
  })

  it('内部作业（无 quoted_price）：profit 为 null', async () => {
    const jobId = await makeJob(10)
    await patch(`/api/jobs/${jobId}`, { status: 'queued' })
    await post(`/api/jobs/${jobId}/done`, {})
    const job = db.prepare('SELECT quoted_price, profit, total_cost FROM jobs WHERE id = ?').get(jobId) as {
      quoted_price: number | null
      profit: number | null
      total_cost: number
    }
    expect(job.quoted_price).toBeNull()
    expect(job.profit).toBeNull()
    expect(job.total_cost).toBeGreaterThan(0)
  })

  it('done 时无库存档案 → 409；guest 全线 401', async () => {
    const res = await post('/api/jobs', {
      title: '无档案纸',
      mode_id: 6,
      paper_id: 10,
      size_key: 'A3',
      quantity: 5,
    })
    const jobId = (res.json() as { id: string }).id
    await patch(`/api/jobs/${jobId}`, { status: 'queued' })
    expect((await post(`/api/jobs/${jobId}/done`, {})).statusCode).toBe(409)

    expect((await app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401)
  })
})
