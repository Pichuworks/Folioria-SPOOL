import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { scheduleBoard } from './jobs.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

let db: DB
function printerId(code: string): number {
  return (db.prepare('SELECT id FROM printers WHERE code = ?').get(code) as { id: number }).id
}

describe('B4 scheduleBoard（按机台泳道）', () => {
  beforeEach(() => {
    db = makeTestDb()
    spoolInit(db, { baseCurrency: 'JPY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'pw-initial-x' })
    importSeed(db)
    createTestUser(db, { email: 'u@x.example' })
  })
  afterEach(() => db.close())

  it('queued/printing 作业按机台编组；due_date 经订单 join；离线压活告警', () => {
    const u = (db.prepare("SELECT id FROM users WHERE email = 'u@x.example'").get() as { id: string }).id
    // 无订单的内部作业（due_date NULL），mode 1 = C850
    db.prepare(
      `INSERT INTO jobs (id, requester_id, title, mode_id, paper_id, size_key, quantity, status, created_at)
       VALUES ('j1', ?, '内部黑白', 1, 1, 'A4', 50, 'queued', '2026-06-10T00:00:00Z')`,
    ).run(u)
    // 带 due_date 的订单作业（order_item → orders.due_date）
    db.prepare(
      `INSERT INTO orders (id, order_number, access_token, customer_id, subtotal, discount, total,
                           status, quote_valid_until, created_at, due_date)
       VALUES ('o1','FOL-1','t1', ?, 14, 0, 14, 'confirmed', '2026-07-01T00:00:00Z', '2026-06-10T00:00:00Z', '2026-06-20T00:00:00Z')`,
    ).run(u)
    db.prepare(
      `INSERT INTO order_items (id, order_id, mode_id, paper_id, size_key, quantity, unit_price_c, line_total, file_status)
       VALUES ('it1','o1',1,1,'A4',200,7,14,'approved')`,
    ).run()
    db.prepare(
      `INSERT INTO jobs (id, order_item_id, requester_id, title, mode_id, paper_id, size_key, quantity, status, created_at)
       VALUES ('j2','it1', ?, '订单黑白', 1, 1, 'A4', 200, 'printing', '2026-06-11T00:00:00Z')`,
    ).run(u)
    // 完成的作业不上板
    db.prepare(
      `INSERT INTO jobs (id, requester_id, title, mode_id, paper_id, size_key, quantity, status, created_at)
       VALUES ('j3', ?, '已完成', 1, 1, 'A4', 10, 'done', '2026-06-09T00:00:00Z')`,
    ).run(u)

    const board = scheduleBoard(db)
    const c850 = board.find((l) => l.code === 'C850')!
    expect(c850.jobs.map((j) => j.id).sort()).toEqual(['j1', 'j2']) // done 不在
    // due_date 排序：j2(2026-06-20) 在 j1(NULL) 前
    expect(c850.jobs[0]!.id).toBe('j2')
    expect(c850.jobs[0]!.due_date).toBe('2026-06-20T00:00:00Z')
    expect(c850.jobs[1]!.due_date).toBeNull()
    // 在线 → 无告警
    expect(c850.offline_with_jobs).toBe(false)

    // 离线但仍压活 → 告警；空闲离线机不告警
    db.prepare('UPDATE printers SET status = ? WHERE id = ?').run('offline', printerId('C850'))
    db.prepare('UPDATE printers SET status = ? WHERE id = ?').run('offline', printerId('G580'))
    const board2 = scheduleBoard(db)
    expect(board2.find((l) => l.code === 'C850')!.offline_with_jobs).toBe(true)
    expect(board2.find((l) => l.code === 'G580')!.offline_with_jobs).toBe(false) // 无活
  })
})

describe('GET /api/jobs/board 权限', () => {
  let app: App
  beforeEach(() => {
    db = makeTestDb()
    spoolInit(db, { baseCurrency: 'JPY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'pw-initial-x' })
    importSeed(db)
    createTestUser(db, { email: 'c@x.example' })
    createTestUser(db, { email: 'staff@x.example', role: 'admin' })
    app = buildApp(db)
  })
  afterEach(async () => {
    await app.close()
    db.close()
  })
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
    const m = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
    return `${SESSION_COOKIE}=${m?.[1]}`
  }

  it('admin 200 数组；customer 403', async () => {
    const admin = await login('staff@x.example')
    const ok = await app.inject({ method: 'GET', url: '/api/jobs/board', headers: { cookie: admin } })
    expect(ok.statusCode).toBe(200)
    expect(Array.isArray(ok.json())).toBe(true)
    const cust = await login('c@x.example')
    expect((await app.inject({ method: 'GET', url: '/api/jobs/board', headers: { cookie: cust } })).statusCode).toBe(403)
  })
})
