import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

let db: DB
let app: App
let adminCookie: string
let c850Id: number
let tonerId: string

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
  c850Id = (db.prepare("SELECT id FROM printers WHERE code = 'C850'").get() as { id: number }).id
  tonerId = (db.prepare('SELECT id FROM consumables LIMIT 1').get() as { id: string }).id
})
afterEach(async () => {
  await app.close()
  db.close()
})

describe('耗材 CRUD 与寿命数据', () => {
  it('列表含 seed T01：quantity 1、usage 0、remaining_bp 10000', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumables',
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{
      name: string
      quantity: number
      current_usage_pages: number
      remaining_bp: number | null
    }>
    expect(rows.length).toBe(1)
    expect(rows[0]?.quantity).toBe(1)
    expect(rows[0]?.current_usage_pages).toBe(0)
    expect(rows[0]?.remaining_bp).toBe(10000)
  })

  it('per_page 模式缺 rated_life_pages → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/inventory/consumables',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Drum X',
        type: 'drum',
        printer_id: c850Id,
        quantity: 1,
        cost_model: 'per_page',
        unit_cost_c: 50000,
      },
    })
    expect(res.statusCode).toBe(422)
  })

  it('per_job_rule（喷墨）无需寿命，remaining_bp 为 null', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/inventory/consumables',
      headers: { cookie: adminCookie },
      payload: {
        name: 'P708 墨水组',
        type: 'ink',
        printer_id: c850Id,
        quantity: 2,
        cost_model: 'per_job_rule',
        unit_cost_c: 250000,
      },
    })
    expect(created.statusCode).toBe(201)
    expect((created.json() as { remaining_bp: number | null }).remaining_bp).toBeNull()
  })
})

describe('§3.5 耗材换装（单事务）', () => {
  it('toner_change：事件落档 final_usage=54200，usage 清零、installed_at 更新、quantity 1→0', async () => {
    db.prepare('UPDATE consumables SET current_usage_pages = 54200, installed_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00Z',
      tonerId,
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/equipment/${c850Id}/maintenance`,
      headers: { cookie: adminCookie },
      payload: { type: 'toner_change', consumable_id: tonerId, final_usage: 54200, notes: 'T01 换装' },
    })
    expect(res.statusCode).toBe(201)

    const event = db
      .prepare("SELECT type, final_usage, printer_id FROM maintenance_events WHERE type = 'toner_change'")
      .get() as { type: string; final_usage: number; printer_id: number }
    expect(event.final_usage).toBe(54200)
    expect(event.printer_id).toBe(c850Id)

    const consumable = db
      .prepare('SELECT current_usage_pages, installed_at, quantity FROM consumables WHERE id = ?')
      .get(tonerId) as { current_usage_pages: number; installed_at: string; quantity: number }
    expect(consumable.current_usage_pages).toBe(0)
    expect(consumable.installed_at).not.toBe('2026-01-01T00:00:00Z')
    expect(consumable.quantity).toBe(0)
  })

  it('无备品（quantity 0）→ 409，全部状态不变', async () => {
    db.prepare('UPDATE consumables SET quantity = 0, current_usage_pages = 1000 WHERE id = ?').run(tonerId)
    const res = await app.inject({
      method: 'POST',
      url: `/api/equipment/${c850Id}/maintenance`,
      headers: { cookie: adminCookie },
      payload: { type: 'toner_change', consumable_id: tonerId, final_usage: 1000 },
    })
    expect(res.statusCode).toBe(409)
    const c = db.prepare('SELECT current_usage_pages, quantity FROM consumables WHERE id = ?').get(tonerId) as {
      current_usage_pages: number
      quantity: number
    }
    expect(c).toEqual({ current_usage_pages: 1000, quantity: 0 })
    expect(
      (db.prepare('SELECT COUNT(*) n FROM maintenance_events').get() as { n: number }).n,
    ).toBe(0)
  })

  it('toner_change 缺 consumable_id / final_usage → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/equipment/${c850Id}/maintenance`,
      headers: { cookie: adminCookie },
      payload: { type: 'toner_change' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('档案编辑 + 校准事件重置基线并 resolve 提醒（C6）', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/equipment/${c850Id}`,
      headers: { cookie: adminCookie },
      payload: { calibration_interval_pages: 3000, status: 'standby' },
    })
    expect(patched.statusCode).toBe(200)

    db.prepare('UPDATE printers SET total_pages = 5000 WHERE id = ?').run(c850Id)
    const due = await app.inject({
      method: 'GET',
      url: `/api/equipment/${c850Id}`,
      headers: { cookie: adminCookie },
    })
    expect((due.json() as { calibration_due: boolean }).calibration_due).toBe(true)

    db.prepare(
      `INSERT INTO alerts (id, type, severity, target_type, target_id, message, created_at)
       VALUES ('al1', 'calibration_due', 'warning', 'printer', ?, 'due', '2026-06-10T00:00:00Z')`,
    ).run(String(c850Id))

    const calibrated = await app.inject({
      method: 'POST',
      url: `/api/equipment/${c850Id}/maintenance`,
      headers: { cookie: adminCookie },
      payload: { type: 'calibration', notes: '色彩校准' },
    })
    expect(calibrated.statusCode).toBe(201)

    const printer = db
      .prepare('SELECT last_calibration_pages, last_calibration_at FROM printers WHERE id = ?')
      .get(c850Id) as { last_calibration_pages: number; last_calibration_at: string | null }
    expect(printer.last_calibration_pages).toBe(5000)
    expect(printer.last_calibration_at).not.toBeNull()

    const after = await app.inject({
      method: 'GET',
      url: `/api/equipment/${c850Id}`,
      headers: { cookie: adminCookie },
    })
    expect((after.json() as { calibration_due: boolean }).calibration_due).toBe(false)

    const alert = db.prepare("SELECT resolved_at FROM alerts WHERE id = 'al1'").get() as {
      resolved_at: string | null
    }
    expect(alert.resolved_at).not.toBeNull()
  })

  it('普通维护事件（nozzle_check）直接落档', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/equipment/${c850Id}/maintenance`,
      headers: { cookie: adminCookie },
      payload: { type: 'nozzle_check', notes: '例行', cost: 0 },
    })
    expect(res.statusCode).toBe(201)
    expect(
      (db.prepare('SELECT COUNT(*) n FROM maintenance_events').get() as { n: number }).n,
    ).toBe(1)
  })
})
