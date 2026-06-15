import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const post = async (url: string, payload: Record<string, unknown>) =>
  await app.inject({ method: 'POST', url, payload, headers: { cookie: adminCookie } })

async function makeStock(paperId: number, sizeKey: string, quantity: number): Promise<string> {
  const res = await post('/api/inventory/stocks', {
    paper_id: paperId,
    size_key: sizeKey,
    location_id: '3F纸张柜·A区',
  })
  expect(res.statusCode).toBe(201)
  const id = (res.json() as { id: string }).id
  if (quantity > 0) {
    const mv = await post(`/api/inventory/stocks/${id}/movements`, {
      action: 'purchase',
      quantity_delta: quantity,
    })
    expect(mv.statusCode).toBe(201)
  }
  return id
}

describe('locations / stocks 基础', () => {
  it('库存端点属管理域：guest 401', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/inventory/stocks' })).statusCode,
    ).toBe(401)
  })

  it('location 创建 + 湿度状态更新', async () => {
    const created = await post('/api/inventory/locations', { id: '2F暗房' })
    expect(created.statusCode).toBe(201)
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/inventory/locations/2F暗房',
      payload: { moisture_status: 'warning' },
      headers: { cookie: adminCookie },
    })
    expect(patched.statusCode).toBe(200)
    expect((patched.json() as { moisture_status: string }).moisture_status).toBe('warning')
  })

  it('同 纸×尺寸×位置 重复建档 → 409', async () => {
    await makeStock(1, 'A4', 0)
    const dup = await post('/api/inventory/stocks', {
      paper_id: 1,
      size_key: 'A4',
      location_id: '3F纸张柜·A区',
    })
    expect(dup.statusCode).toBe(409)
  })
})

describe('出入库 movements（事件溯源）', () => {
  it('purchase 入库带原币留痕；consume 出库；账面随动', async () => {
    const id = await makeStock(1, 'A4', 0)
    const buy = await post(`/api/inventory/stocks/${id}/movements`, {
      action: 'purchase',
      quantity_delta: 500,
      original_currency: 'CNY',
      original_amount: 12000,
      converted_cost_c: 8000,
      exchange_rate_note: '1CNY≈20.6JPY @2026-06',
    })
    expect(buy.statusCode).toBe(201)

    const use = await post(`/api/inventory/stocks/${id}/movements`, {
      action: 'consume',
      quantity_delta: -200,
      reason: '手动出库',
    })
    expect(use.statusCode).toBe(201)

    const stock = db.prepare('SELECT quantity FROM paper_stocks WHERE id = ?').get(id) as {
      quantity: number
    }
    expect(stock.quantity).toBe(300)

    const logs = db
      .prepare("SELECT action, quantity_delta, original_currency FROM inventory_log WHERE target_id = ? ORDER BY created_at")
      .all(id) as Array<{ action: string; quantity_delta: number; original_currency: string | null }>
    expect(logs.length).toBe(2)
    expect(logs[0]).toEqual({ action: 'purchase', quantity_delta: 500, original_currency: 'CNY' })
    expect(logs[1]?.quantity_delta).toBe(-200)
  })

  it('库存击穿为负 → 409；符号与 action 不符 → 422；原币字段只许 purchase 用 → 422', async () => {
    const id = await makeStock(1, 'A4', 10)
    expect(
      (
        await post(`/api/inventory/stocks/${id}/movements`, {
          action: 'consume',
          quantity_delta: -11,
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (
        await post(`/api/inventory/stocks/${id}/movements`, {
          action: 'purchase',
          quantity_delta: -5,
        })
      ).statusCode,
    ).toBe(422)
    expect(
      (
        await post(`/api/inventory/stocks/${id}/movements`, {
          action: 'consume',
          quantity_delta: -1,
          original_currency: 'CNY',
          original_amount: 100,
        })
      ).statusCode,
    ).toBe(422)
  })

  it('movements 不接受 convert（裁切转换必须走成对接口）', async () => {
    const id = await makeStock(1, 'A4', 10)
    expect(
      (
        await post(`/api/inventory/stocks/${id}/movements`, {
          action: 'convert',
          quantity_delta: -5,
        })
      ).statusCode,
    ).toBe(422)
  })
})

describe('§3.4 裁切转换守恒', () => {
  it('S4: 跨纸种 convert 拒绝（D1 只允许同纸不同尺寸折算），账面零变化', async () => {
    const fromId = await makeStock(6, 'A3P', 50)
    const toId = await makeStock(1, 'A4', 0)

    const res = await post('/api/inventory/convert', {
      from: { stock_id: fromId, quantity_delta: -10 },
      to: { stock_id: toId, quantity_delta: 20 },
    })
    expect(res.statusCode).toBe(422)
    expect((res.json() as { error: string }).error).toBe('cross_paper')

    const qty = (id: string) =>
      (db.prepare('SELECT quantity FROM paper_stocks WHERE id = ?').get(id) as { quantity: number }).quantity
    expect(qty(fromId)).toBe(50)
    expect(qty(toId)).toBe(0)
    expect(
      (db.prepare("SELECT COUNT(*) n FROM inventory_log WHERE action = 'convert'").get() as { n: number }).n,
    ).toBe(0)
  })

  it('A3+ −10 / A4 +20 成对日志同 convert_group，账面同步', async () => {
    const fromId = await makeStock(6, 'A3P', 50)
    const toId = await makeStock(6, 'A4', 0)

    const res = await post('/api/inventory/convert', {
      from: { stock_id: fromId, quantity_delta: -10 },
      to: { stock_id: toId, quantity_delta: 20 },
      reason: 'A3+ 对裁 A4',
    })
    expect(res.statusCode).toBe(201)

    const fromQty = (db.prepare('SELECT quantity FROM paper_stocks WHERE id = ?').get(fromId) as { quantity: number }).quantity
    const toQty = (db.prepare('SELECT quantity FROM paper_stocks WHERE id = ?').get(toId) as { quantity: number }).quantity
    expect(fromQty).toBe(40)
    expect(toQty).toBe(20)

    const groups = db
      .prepare(
        `SELECT convert_group, COUNT(*) n, SUM(CASE WHEN quantity_delta < 0 THEN 1 ELSE 0 END) outs
         FROM inventory_log WHERE action = 'convert' GROUP BY convert_group`,
      )
      .all() as Array<{ convert_group: string; n: number; outs: number }>
    expect(groups.length).toBe(1)
    expect(groups[0]?.n).toBe(2)
    expect(groups[0]?.outs).toBe(1)
  })

  it('方向错误 / 同一库存 / 库存不足 → 拒绝', async () => {
    const fromId = await makeStock(6, 'A3P', 5)
    const toId = await makeStock(6, 'A4', 0)

    expect(
      (
        await post('/api/inventory/convert', {
          from: { stock_id: fromId, quantity_delta: 10 },
          to: { stock_id: toId, quantity_delta: 20 },
        })
      ).statusCode,
    ).toBe(422)

    expect(
      (
        await post('/api/inventory/convert', {
          from: { stock_id: fromId, quantity_delta: -2 },
          to: { stock_id: fromId, quantity_delta: 4 },
        })
      ).statusCode,
    ).toBe(422)

    expect(
      (
        await post('/api/inventory/convert', {
          from: { stock_id: fromId, quantity_delta: -10 },
          to: { stock_id: toId, quantity_delta: 20 },
        })
      ).statusCode,
    ).toBe(409)
  })
})

describe('inventory_log 查询', () => {
  it('按 target / action 过滤', async () => {
    const id = await makeStock(1, 'A4', 100)
    await post(`/api/inventory/stocks/${id}/movements`, {
      action: 'scrap',
      quantity_delta: -3,
      reason: '受潮报废',
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/inventory/log?target_id=${id}&action=scrap`,
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: Array<{ action: string }> }
    expect(body.data.length).toBe(1)
    expect(body.data[0]?.action).toBe('scrap')
  })
})
