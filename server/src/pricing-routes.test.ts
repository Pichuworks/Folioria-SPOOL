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

  it('D36 sizes 物理 mm：回填标准尺寸、A3P 留空、PATCH 可填、POST 可带', async () => {
    const sizes = (
      await app.inject({ method: 'GET', url: '/api/pricing/sizes', headers: { cookie: adminCookie } })
    ).json() as Array<{ key: string; width_mm: number | null; height_mm: number | null }>
    const a4 = sizes.find((s) => s.key === 'A4')!
    expect(a4.width_mm).toBe(210)
    expect(a4.height_mm).toBe(297)
    expect(sizes.find((s) => s.key === 'A3')).toMatchObject({ width_mm: 297, height_mm: 420 })
    expect(sizes.find((s) => s.key === 'SRA3')).toMatchObject({ width_mm: 320, height_mm: 450 })
    // A3P（A3+）回填留 NULL，待 admin 填
    expect(sizes.find((s) => s.key === 'A3P')).toMatchObject({ width_mm: null, height_mm: null })

    // admin 给 A3P 配 mm
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/pricing/sizes/A3P',
      headers: { cookie: adminCookie },
      payload: { width_mm: 329, height_mm: 483 },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({ width_mm: 329, height_mm: 483 })

    // 清空（设回 null）
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/pricing/sizes/A3P',
      headers: { cookie: adminCookie },
      payload: { width_mm: null, height_mm: null },
    })
    expect(cleared.json()).toMatchObject({ width_mm: null, height_mm: null })

    // 新建带 mm
    const created = await app.inject({
      method: 'POST',
      url: '/api/pricing/sizes',
      headers: { cookie: adminCookie },
      payload: { key: 'B4', label: 'B4', area: 140, width_mm: 257, height_mm: 364 },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ width_mm: 257, height_mm: 364 })

    // 非整数 mm → schema 422
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/pricing/sizes',
          headers: { cookie: adminCookie },
          payload: { key: 'X9', label: 'X9', area: 10, width_mm: 12.5 },
        })
      ).statusCode,
    ).toBe(422)
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

  it('S5: modes 未知 printer_id/ref_size/max_size → 409 unknown_printer_or_size（而非 500）', async () => {
    const base = {
      name: 'fk-probe',
      printer_id: 1,
      ink_type: 'toner',
      pricing_mode: 'set',
      ink_price_c: 100,
      yield_sheets: 100,
      ref_size: 'A4',
      max_size: 'A4',
    }
    for (const broken of [{ printer_id: 999 }, { ref_size: 'Z9' }, { max_size: 'Z9' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pricing/modes',
        headers: { cookie: adminCookie },
        payload: { ...base, ...broken },
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as { error: string }).error).toBe('unknown_printer_or_size')
    }

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/pricing/modes/1',
      headers: { cookie: adminCookie },
      payload: { printer_id: 999 },
    })
    expect(patched.statusCode).toBe(409)
    expect((patched.json() as { error: string }).error).toBe('unknown_printer_or_size')
  })

  it('D25: color_class 可经 PATCH 设定并回显（属性配置器色彩档）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/pricing/modes/1',
      headers: { cookie: adminCookie },
      payload: { color_class: 'bw' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { color_class: string }).color_class).toBe('bw')
    const modes = (
      await app.inject({ method: 'GET', url: '/api/pricing/modes', headers: { cookie: adminCookie } })
    ).json() as Array<{ id: number; color_class: string | null }>
    expect(modes.find((m) => m.id === 1)?.color_class).toBe('bw')
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

describe('限流（PRD §6：/api/calculator/quote 按 IP）', () => {
  it('同 IP 第 61 次报价 → 429', async () => {
    const payload = { mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 1 }
    const headers = { 'cf-connecting-ip': '198.51.100.9' }
    for (let i = 0; i < 60; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/calculator/quote', payload, headers })
      expect(r.statusCode).toBe(200)
    }
    expect(
      (await app.inject({ method: 'POST', url: '/api/calculator/quote', payload, headers }))
        .statusCode,
    ).toBe(429)
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

  it('quotes 行带 display（服务端唯一除法点）：用例 A 6×6 A3 = 0.74/2.25/0.9', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/pricing/quotes',
      headers: { cookie: adminCookie },
    })
    const rows = res.json() as Array<Record<string, unknown>>
    const a = rows.find((r) => r['mode_id'] === 6 && r['paper_id'] === 6 && r['size_key'] === 'A3')
    expect(a?.['total_display']).toBe('¥0.74')
    expect(a?.['auto_display']).toBe('¥2.25')
    expect(a?.['sell_display']).toBe('¥0.9')
    expect(a?.['flag']).toBe('below_margin')
  })
})

describe('③⑤ /api/calculator/products（客户产品视图）', () => {
  it('color_class 由 seed 导入器派生（K 君映射）', () => {
    const cc = Object.fromEntries(
      (db.prepare('SELECT id, color_class FROM print_modes').all() as Array<{ id: number; color_class: string }>).map(
        (m) => [m.id, m.color_class],
      ),
    )
    expect(cc[1]).toBe('bw') // C850 黑白单
    expect(cc[6]).toBe('color') // C850 彩图单（非 photo）
    expect(cc[7]).toBe('photo-art') // P708 原装
    expect(cc[9]).toBe('photo-premium') // G580
    expect(cc[10]).toBe('photo-value') // L15168 照片
    expect(cc[11]).toBe('bw,color') // L15168 文档单
  })

  it('产品按 色彩档×技术×纸×尺寸×双面 折叠；含正售价；不泄露机器名/成本', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/calculator/products' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      products: Array<{ category: string; tech: string; sell_c: number; mode_id: number; duplex: boolean }>
      papers: unknown[]
      sizes: unknown[]
    }
    expect(body.products.length).toBeGreaterThan(50)
    const cats = new Set(body.products.map((p) => p.category))
    expect(cats.has('bw')).toBe(true)
    expect(cats.has('color')).toBe(true)
    expect([...cats].some((c) => c.startsWith('photo'))).toBe(true)
    expect(body.products.every((p) => p.sell_c > 0)).toBe(true)
    // §6 双域：不得泄露 cost/profit/margin，也不得出现机器型号名
    expect(collectForbiddenKeys(body)).toEqual([])
    const s = JSON.stringify(body)
    expect(s.includes('C850')).toBe(false)
    expect(s.includes('P708')).toBe(false)
    expect(s.includes('OKI')).toBe(false)
  })

  it('member 取内部价口径', async () => {
    db.prepare(
      `UPDATE combo_prices SET internal_sell_c = 5
       WHERE size_key = 'A4' AND combo_id = (SELECT id FROM combos WHERE mode_id = 1 AND paper_id = 1)`,
    ).run()
    // 内部价覆盖：member 看到的 bw×该纸×A4 产品价 ≤ 对外
    const pub = (await app.inject({ method: 'GET', url: '/api/calculator/products' })).json() as {
      products: Array<{ category: string; paper_id: number; size_key: string; sell_c: number }>
    }
    const mem = (
      await app.inject({ method: 'GET', url: '/api/calculator/products', headers: { cookie: memberCookie } })
    ).json() as { products: Array<{ category: string; paper_id: number; size_key: string; sell_c: number }> }
    const pick = (b: { products: Array<{ category: string; paper_id: number; size_key: string; sell_c: number }> }) =>
      b.products.find((p) => p.category === 'bw' && p.paper_id === 1 && p.size_key === 'A4')?.sell_c
    expect(pick(mem)!).toBeLessThanOrEqual(pick(pub)!)
  })
})
