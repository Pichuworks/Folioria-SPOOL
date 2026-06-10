import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { collectForbiddenKeys, createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

let db: DB
let app: App
let adminCookie: string
let memberCookie: string

beforeEach(async () => {
  db = makeTestDb()
  withSystemConfig(db)
  importSeed(db)
  createTestUser(db, { email: 'admin@t.jp', role: 'admin' })
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
  const raw = String(res.headers['set-cookie'])
  const token = /spool_session=([^;]+)/.exec(raw)?.[1]
  return `${SESSION_COOKIE}=${token}`
}

describe('管理域守卫（§6）', () => {
  it('guest 401，member 403', async () => {
    const payload = { key: 'B5', label: 'B5', area: 60, sort: 9 }
    expect(
      (await app.inject({ method: 'POST', url: '/api/pricing/sizes', payload })).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/pricing/sizes',
          payload,
          headers: { cookie: memberCookie },
        })
      ).statusCode,
    ).toBe(403)
  })
})

describe('§7 API 层金额边界（Fastify schema 422）', () => {
  const mode = {
    name: 'X',
    printer_id: 1,
    ink_type: 'toner',
    pricing_mode: 'set',
    yield_sheets: 100,
    ref_size: 'A4',
    max_size: 'A4',
  }
  it.each([1.5, '100'])('ink_price_c = %o → 422', async (bad) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pricing/modes',
      headers: { cookie: adminCookie },
      payload: { ...mode, ink_price_c: bad },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('定价四表 CRUD', () => {
  it('sizes：新建/修改/删除；被引用的尺寸删除 → 409', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/pricing/sizes',
      headers: { cookie: adminCookie },
      payload: { key: 'B5', label: 'B5', area: 60, sort: 9 },
    })
    expect(created.statusCode).toBe(201)

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/pricing/sizes/B5',
      headers: { cookie: adminCookie },
      payload: { label: 'B5判' },
    })
    expect(patched.statusCode).toBe(200)
    expect((patched.json() as { label: string }).label).toBe('B5判')

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/pricing/sizes/B5',
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(204)

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/pricing/sizes/A4',
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(409)
  })

  it('modes：ml 计价缺 ml_per_batch → 422；archive 后报价与 options 同步消失', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/pricing/modes',
      headers: { cookie: adminCookie },
      payload: {
        name: 'ml-broken',
        printer_id: 1,
        ink_type: 'dye',
        pricing_mode: 'ml',
        ink_price_c: 100,
        yield_sheets: 100,
        ref_size: 'A4',
        max_size: 'A4',
      },
    })
    expect(bad.statusCode).toBe(422)

    const archived = await app.inject({
      method: 'DELETE',
      url: '/api/pricing/modes/1',
      headers: { cookie: adminCookie },
    })
    expect(archived.statusCode).toBe(204)

    const quote = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 100 },
    })
    expect(quote.statusCode).toBe(404)
  })

  it('改一次采购价，下游报价自动更新（推导模型核心性质）', async () => {
    const before = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 3, size_key: 'A4', quantity: 100 },
    })
    expect((before.json() as { unit_price_c: number }).unit_price_c).toBe(22)

    const put = await app.inject({
      method: 'PUT',
      url: '/api/pricing/paper-size-costs',
      headers: { cookie: adminCookie },
      payload: { paper_id: 3, size_key: 'A4', pack_price_c: 4320, pack_count: 500 },
    })
    expect(put.statusCode).toBe(200)

    const after = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 3, size_key: 'A4', quantity: 100 },
    })
    // paper_c 4.32→8.64→9, total 3+9=12, auto=ceil(120000/3300)=37
    expect((after.json() as { unit_price_c: number }).unit_price_c).toBe(37)
  })

  it('combos：重复 409；新建组合 + 手动价 → 报价生效；置 null 回落自动', async () => {
    const dup = await app.inject({
      method: 'POST',
      url: '/api/pricing/combos',
      headers: { cookie: adminCookie },
      payload: { mode_id: 1, paper_id: 1 },
    })
    expect(dup.statusCode).toBe(409)

    const created = await app.inject({
      method: 'POST',
      url: '/api/pricing/combos',
      headers: { cookie: adminCookie },
      payload: { mode_id: 1, paper_id: 11 },
    })
    expect(created.statusCode).toBe(201)
    const comboId = (created.json() as { id: number }).id

    const quoteAuto = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 11, size_key: 'A3', quantity: 1 },
    })
    expect(quoteAuto.statusCode).toBe(200)
    const autoPrice = (quoteAuto.json() as { unit_price_c: number }).unit_price_c

    const put = await app.inject({
      method: 'PUT',
      url: `/api/pricing/combos/${comboId}/prices/A3`,
      headers: { cookie: adminCookie },
      payload: { sell_c: 999 },
    })
    expect(put.statusCode).toBe(200)
    const quoteManual = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 11, size_key: 'A3', quantity: 1 },
    })
    expect((quoteManual.json() as { unit_price_c: number }).unit_price_c).toBe(999)

    await app.inject({
      method: 'PUT',
      url: `/api/pricing/combos/${comboId}/prices/A3`,
      headers: { cookie: adminCookie },
      payload: { sell_c: null },
    })
    const quoteBack = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 11, size_key: 'A3', quantity: 1 },
    })
    expect((quoteBack.json() as { unit_price_c: number }).unit_price_c).toBe(autoPrice)
  })
})

describe('计算器（下单域）', () => {
  it('quote：mode1×paper1@A4×200 → 单价 ¥0.07，小计 ¥14（唯一舍入点贯通）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body['unit_price_c']).toBe(7)
    expect(body['unit_display']).toBe('¥0.07')
    expect(body['line_total']).toBe(14)
    expect(body['line_total_display']).toBe('¥14')
  })

  it('可选性三条件不满足 → 404（§2.4 经 API）', async () => {
    for (const payload of [
      { mode_id: 9, paper_id: 1, size_key: 'A3', quantity: 1 },
      { mode_id: 6, paper_id: 7, size_key: 'A4', quantity: 1 },
      { mode_id: 14, paper_id: 10, size_key: 'A4', quantity: 1 },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/calculator/quote', payload })).statusCode,
      ).toBe(404)
    }
  })

  it('quantity 0 / 1.5 → 422', async () => {
    for (const quantity of [0, 1.5]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/calculator/quote',
            payload: { mode_id: 1, paper_id: 1, size_key: 'A4', quantity },
          })
        ).statusCode,
      ).toBe(422)
    }
  })

  it('member 内部价覆盖（B1.1）：internal_sell_c 只对 member 生效', async () => {
    db.prepare(
      "UPDATE combo_prices SET internal_sell_c = 5 WHERE combo_id = 1 AND size_key = 'A4'",
    ).run()
    const guest = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 100 },
    })
    expect((guest.json() as { unit_price_c: number }).unit_price_c).toBe(7)
    const member = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 100 },
      headers: { cookie: memberCookie },
    })
    expect((member.json() as { unit_price_c: number }).unit_price_c).toBe(5)
  })

  it('§6 序列化白名单：options 与 quote 深度遍历无 cost/profit/margin 键', async () => {
    const options = await app.inject({ method: 'GET', url: '/api/calculator/options' })
    expect(options.statusCode).toBe(200)
    expect(collectForbiddenKeys(options.json())).toEqual([])

    const quote = await app.inject({
      method: 'POST',
      url: '/api/calculator/quote',
      payload: { mode_id: 7, paper_id: 11, size_key: 'A3', quantity: 10 },
    })
    expect(collectForbiddenKeys(quote.json())).toEqual([])
  })

  it('options：187 个可报价组合尺寸对全量带价', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/calculator/options' })
    const body = res.json() as {
      options: Array<{ mode_id: number; paper_id: number; prices: Record<string, unknown> }>
    }
    const totalPairs = body.options.reduce((n, o) => n + Object.keys(o.prices).length, 0)
    expect(totalPairs).toBe(187)
    const m9p11 = body.options.find((o) => o.mode_id === 9 && o.paper_id === 11)
    expect(m9p11?.prices['A4']).toBeDefined()
    expect(m9p11?.prices['A3']).toBeUndefined()
  })
})

describe('管理域成本速查', () => {
  it('GET /api/admin/pricing/quotes：187 行含成本与警示 flag；下单域不可达', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/pricing/quotes',
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ flag: string; total_c: number }>
    expect(rows.length).toBe(187)
    expect(rows.filter((r) => r.flag === 'LOSS').length).toBe(4)

    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/pricing/quotes' })).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/pricing/quotes',
          headers: { cookie: memberCookie },
        })
      ).statusCode,
    ).toBe(403)
  })
})
