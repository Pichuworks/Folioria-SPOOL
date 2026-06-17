import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { raiseAlert } from './alerts.js'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

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

describe('Dashboard 四宫格', () => {
  it('待办 / 库存预警 / 本月统计（内部消耗单列）/ 设备状态', async () => {
    db.prepare(
      "INSERT INTO paper_stocks (id, paper_id, size_key, quantity, location_id) VALUES ('s1', 1, 'A4', 500, NULL)",
    ).run()
    const adminId = (db.prepare("SELECT id FROM users WHERE email = 'admin@t.jp'").get() as { id: string }).id
    const month = new Date().toISOString().slice(0, 7)

    // 外部收费作业（done）+ 内部作业（done）+ 排队中作业
    db.prepare(
      `INSERT INTO jobs (id, requester_id, title, mode_id, paper_id, size_key, quantity,
                         quoted_price, total_cost, profit, status, created_at, completed_at)
       VALUES ('j1', ?, '外部', 1, 1, 'A4', 200, 14, 71, -57, 'done', ?, ?)`,
    ).run(adminId, `${month}-01T00:00:00Z`, `${month}-02T00:00:00Z`)
    db.prepare(
      `INSERT INTO jobs (id, requester_id, title, mode_id, paper_id, size_key, quantity,
                         total_cost, status, created_at, completed_at)
       VALUES ('j2', ?, '内部', 1, 1, 'A4', 50, 18, 'done', ?, ?)`,
    ).run(adminId, `${month}-03T00:00:00Z`, `${month}-04T00:00:00Z`)
    db.prepare(
      `INSERT INTO jobs (id, requester_id, title, mode_id, paper_id, size_key, quantity, status, created_at)
       VALUES ('j3', ?, '排队', 1, 1, 'A4', 10, 'queued', ?)`,
    ).run(adminId, `${month}-05T00:00:00Z`)

    raiseAlert(db, {
      type: 'low_stock',
      severity: 'warning',
      target_type: 'paper_stock',
      target_id: 's1',
      message: 'low',
    })
    raiseAlert(db, {
      type: 'calibration_due',
      severity: 'warning',
      target_type: 'printer',
      target_id: '1',
      message: 'due',
    })

    const res = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: adminCookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      todo: { jobs_active: number; maintenance_alerts: number; orders_active: number }
      inventory_alerts: Array<{ type: string }>
      monthly: {
        jobs_done: number
        revenue: number
        external_cost: number
        internal_cost: number
        profit: number
        revenue_display: string
        profit_display: string
      }
      equipment: Array<{ code: string; status: string; calibration_due: boolean }>
    }

    expect(body.todo.jobs_active).toBe(1)
    expect(body.todo.maintenance_alerts).toBe(1)
    expect(body.todo.orders_active).toBe(0)

    expect(body.inventory_alerts.some((a) => a.type === 'low_stock')).toBe(true)

    expect(body.monthly.jobs_done).toBe(2)
    expect(body.monthly.revenue).toBe(14)
    expect(body.monthly.external_cost).toBe(71)
    expect(body.monthly.internal_cost).toBe(18)
    expect(body.monthly.profit).toBe(-57)
    // 金额展示走唯一除法点 formatMoney（铁律 2），dp>0 货币不再裸渲染最小单位
    expect(body.monthly.revenue_display).toBe('¥14')
    expect(body.monthly.profit_display).toBe('-¥57')

    expect(body.equipment.length).toBe(5)
    expect(body.equipment[0]?.code).toBe('C850')
  })

  it('guest → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401)
  })
})
