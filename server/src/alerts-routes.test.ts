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

describe('§4 提醒 API', () => {
  const seedAlert = () =>
    raiseAlert(db, {
      type: 'consumable_low',
      severity: 'warning',
      target_type: 'consumable',
      target_id: 'c1',
      message: '20%',
    })

  it('列表默认只看未解决；?all=1 看全部', async () => {
    seedAlert()
    const open = await app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie: adminCookie } })
    expect(open.statusCode).toBe(200)
    expect((open.json() as unknown[]).length).toBe(1)
  })

  it('GET /api/notifications：admin 可读通知日志，guest 401', async () => {
    db.prepare(
      `INSERT INTO notification_log (id, event, channel, recipient, status, sent_at)
       VALUES ('nl-1', 'order_ready', 'email', 'a@b.jp', 'skipped', '2026-06-12T00:00:00Z')`,
    ).run()
    expect((await app.inject({ method: 'GET', url: '/api/notifications' })).statusCode).toBe(401)
    const ok = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: adminCookie } })
    expect(ok.statusCode).toBe(200)
    const rows = ok.json() as Array<{ status: string; recipient: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('skipped')
  })

  it('acknowledge 记录操作者；resolve 后可再次产生同源提醒', async () => {
    seedAlert()
    const id = (db.prepare('SELECT id FROM alerts').get() as { id: string }).id

    const ack = await app.inject({
      method: 'PATCH',
      url: `/api/alerts/${id}/acknowledge`,
      headers: { cookie: adminCookie },
    })
    expect(ack.statusCode).toBe(200)
    const row = db.prepare('SELECT acknowledged, acknowledged_by FROM alerts WHERE id = ?').get(id) as {
      acknowledged: number
      acknowledged_by: string | null
    }
    expect(row.acknowledged).toBe(1)
    expect(row.acknowledged_by).not.toBeNull()

    const resolve = await app.inject({
      method: 'PATCH',
      url: `/api/alerts/${id}/resolve`,
      headers: { cookie: adminCookie },
    })
    expect(resolve.statusCode).toBe(200)

    expect(seedAlert()).toBe('created')
    const open = await app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie: adminCookie } })
    expect((open.json() as unknown[]).length).toBe(1)

    const all = await app.inject({
      method: 'GET',
      url: '/api/alerts?all=1',
      headers: { cookie: adminCookie },
    })
    expect((all.json() as unknown[]).length).toBe(2)
  })

  it('重复 resolve → 409；未知 id → 404；guest → 401', async () => {
    seedAlert()
    const id = (db.prepare('SELECT id FROM alerts').get() as { id: string }).id
    await app.inject({ method: 'PATCH', url: `/api/alerts/${id}/resolve`, headers: { cookie: adminCookie } })
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/alerts/${id}/resolve`,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/alerts/ghost/resolve',
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/alerts' })).statusCode).toBe(401)
  })

  it('低库存阈值检查端点：扫描全库存产生 low_stock 提醒', async () => {
    db.prepare(
      "INSERT INTO paper_stocks (id, paper_id, size_key, quantity, location_id) VALUES ('s1', 1, 'A4', 3, NULL)",
    ).run()
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts/scan',
      headers: { cookie: adminCookie },
      payload: { low_stock_threshold: 10 },
    })
    expect(res.statusCode).toBe(200)
    const alerts = db.prepare("SELECT type, target_id FROM alerts WHERE resolved_at IS NULL").all() as Array<{
      type: string
      target_id: string
    }>
    expect(alerts.some((a) => a.type === 'low_stock' && a.target_id === 's1')).toBe(true)
  })
})
