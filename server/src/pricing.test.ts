import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DB } from './db.js'
import { invalidateConfigCache, listQuotable, overheadC, quote } from './pricing.js'
import { importSeed } from './seed.js'
import { makeTestDb, withSystemConfig } from './test-helpers.js'

let db: DB
beforeEach(() => {
  db = makeTestDb()
  withSystemConfig(db)
  importSeed(db)
})
afterEach(() => {
  db.close()
})

describe('§2.1 成本推导（seed 基准）', () => {
  const vectors: ReadonlyArray<readonly [string, number, number, string, number, number, number]> =
    [
      ['A', 6, 6, 'A3', 56, 16, 72],
      ['B', 1, 1, 'A4', 3, 3, 6],
      ['C', 7, 11, 'A3', 2273, 246, 2519],
      ['D', 6, 8, 'A4', 28, 29, 57],
    ]
  it.each(vectors)('用例 %s: mode %i × paper %i @ %s → ink %i + paper %i = %i', (_label, m, p, s, ink, paper, total) => {
    const q = quote(db, m, p, s)
    expect(q).not.toBeNull()
    expect(q?.ink_c).toBe(ink)
    expect(q?.paper_c).toBe(paper)
    expect(q?.total_c).toBe(total)
  })

  it('ml 计价分支：mode 8 P708灌装 eff = 100 × 1000 = 100000_c → ink@A3 = 227', () => {
    const q = quote(db, 8, 11, 'A3')
    expect(q?.ink_c).toBe(227)
    expect(q?.paper_c).toBe(246)
    expect(q?.total_c).toBe(473)
  })

  it('overhead_c：C850 = round(2060000 / (36×2000)) = 29（不计入报价 total_c）', () => {
    const c850 = db.prepare("SELECT id FROM printers WHERE code = 'C850'").get() as { id: number }
    expect(overheadC(db, c850.id)).toBe(29)
  })
})
describe('§2.2 自动地板价（ceil，永不击穿 67%）', () => {
  const vectors: ReadonlyArray<readonly [number, number, string, number, number]> = [
    [6, 6, 'A3', 72, 219],
    [1, 1, 'A4', 6, 19],
    [6, 8, 'A4', 57, 173],
    [7, 11, 'A3', 2519, 7634],
  ]
  it.each(vectors)('mode %i × paper %i @ %s: total %i → auto %i', (m, p, s, total, auto) => {
    const q = quote(db, m, p, s)
    expect(q?.total_c).toBe(total)
    expect(q?.auto_sell_c).toBe(auto)
  })

  it('性质：全部 60 组合 (auto−total)×10000 ≥ 6700×auto（整数精确，不经浮点）', () => {
    const all = listQuotable(db)
    expect(all.length).toBe(60)
    for (const q of all) {
      expect((q.auto_sell_c - q.total_c) * 10000).toBeGreaterThanOrEqual(6700 * q.auto_sell_c)
    }
  })
})

describe('§2.3 报价规则（D8 防翻案：手动价生效并警示，禁止静默抬价）', () => {
  it('force OFF（默认）：彩图×哑光铜版纸 A3 手动 90 → sell 90，below_margin', () => {
    const q = quote(db, 6, 6, 'A3')
    expect(q?.sell_c).toBe(90)
    expect(q?.auto_sell_c).toBe(219)
    expect(q?.source).toBe('manual')
    expect(q?.flag).toBe('below_margin')
  })

  it('force OFF：P708原装×RC艺术纸 A3 手动 2500 < total 2519 → sell 2500，LOSS', () => {
    const q = quote(db, 7, 11, 'A3')
    expect(q?.sell_c).toBe(2500)
    expect(q?.auto_sell_c).toBe(7634)
    expect(q?.flag).toBe('LOSS')
  })

  it('force OFF：G580×珠光纸 6寸 手动 150 → sell 150，below_margin', () => {
    const q = quote(db, 10, 12, '6')
    expect(q?.sell_c).toBe(150)
    expect(q?.auto_sell_c).toBe(188)
    expect(q?.flag).toBe('below_margin')
  })

  it('force OFF：黑白×金华盛 A4 无手动 → sell 31，auto', () => {
    const q = quote(db, 1, 3, 'A4')
    expect(q?.sell_c).toBe(31)
    expect(q?.auto_sell_c).toBe(31)
    expect(q?.source).toBe('auto')
    expect(q?.flag).toBe('auto')
  })

  it('force ON：黑白×亚太森博 A4 → sell 19，forced', () => {
    db.prepare('UPDATE system_config SET force_min_margin = 1 WHERE id = 1').run()
    invalidateConfigCache()
    const q = quote(db, 1, 1, 'A4')
    expect(q?.sell_c).toBe(19)
    expect(q?.flag).toBe('forced')
  })

  it('手动价 ≥ 地板价 → 正常 manual，无警示', () => {
    db.prepare("UPDATE combo_prices SET sell_c = 60 WHERE combo_id = 1 AND size_key = 'A4'").run()
    const q = quote(db, 1, 1, 'A4')
    expect(q?.sell_c).toBe(60)
    expect(q?.flag).toBe('manual')
  })

  it('内部价覆盖（B1.1）：internal_sell_c 生效，缺省回落对外逻辑', () => {
    expect(quote(db, 1, 1, 'A4', { internal: true })?.sell_c).toBe(7)
    db.prepare(
      "UPDATE combo_prices SET internal_sell_c = 10 WHERE combo_id = 1 AND size_key = 'A4'",
    ).run()
    expect(quote(db, 1, 1, 'A4', { internal: true })?.sell_c).toBe(10)
    expect(quote(db, 1, 1, 'A4')?.sell_c).toBe(7)
  })
})

describe('§2.4 可选性三条件（任一不满足 → null，API 层转 404）', () => {
  it('mode 9 G580(max=A4) × paper 1 @ A3 → 尺寸越界', () => {
    expect(quote(db, 9, 1, 'A3')).toBeNull()
  })

  it('mode 6 × paper 7 不干胶 @ A3 → 无 paper_size_cost', () => {
    expect(quote(db, 6, 7, 'A3')).toBeNull()
  })

  it('mode 14 × paper 10 → Combo 不存在', () => {
    expect(quote(db, 14, 10, 'A4')).toBeNull()
  })

  it('archived combo 不可报价', () => {
    db.prepare('UPDATE combos SET archived = 1 WHERE id = 1').run()
    expect(quote(db, 1, 1, 'A4')).toBeNull()
  })
})

describe('§2.5 全量回归基线（seed 或公式改动后变化须人工确认）', () => {
  it('60 可报价：手动 13（LOSS 1 / below_margin 7 / 正常 5）；自动 47；sell_c 全为正整数', () => {
    const all = listQuotable(db)
    expect(all.length).toBe(60)

    const manual = all.filter((q) => q.source === 'manual')
    const auto = all.filter((q) => q.source === 'auto')
    expect(manual.length).toBe(13)
    expect(auto.length).toBe(47)

    expect(manual.filter((q) => q.flag === 'LOSS').length).toBe(1)
    expect(manual.filter((q) => q.flag === 'below_margin').length).toBe(7)
    expect(manual.filter((q) => q.flag === 'manual').length).toBe(5)

    for (const q of all) {
      expect(Number.isSafeInteger(q.sell_c)).toBe(true)
      expect(q.sell_c).toBeGreaterThan(0)
    }
  })
})

describe('quote() 与 listQuotable/deriveQuoteFromRow 逐行等价（review M6：防两份 D8 实现漂移）', () => {
  it('每个可报价组合：单查 quote() 与批量行 ink/paper/total/auto/sell/source/flag 全等', () => {
    const all = listQuotable(db)
    expect(all.length).toBe(60)
    for (const row of all) {
      const q = quote(db, row.mode_id, row.paper_id, row.size_key)
      if (!q) throw new Error(`quote null: ${row.mode_id}/${row.paper_id}/${row.size_key}`)
      expect({
        ink_c: q.ink_c, paper_c: q.paper_c, total_c: q.total_c,
        auto_sell_c: q.auto_sell_c, sell_c: q.sell_c, source: q.source, flag: q.flag,
      }).toEqual({
        ink_c: row.ink_c, paper_c: row.paper_c, total_c: row.total_c,
        auto_sell_c: row.auto_sell_c, sell_c: row.sell_c, source: row.source, flag: row.flag,
      })
    }
  })
})

describe('数量阶梯定价（D38 · combo_price_tiers）', () => {
  // combo 1 = (mode 1, paper 1)；A4 基础手动价 7、total 6、auto 19
  const COMBO1 = 1
  function setTiers(rows: ReadonlyArray<readonly [number, number, number | null]>): void {
    const ins = db.prepare(
      'INSERT INTO combo_price_tiers (combo_id, size_key, min_qty, sell_c, internal_sell_c) VALUES (?, ?, ?, ?, ?)',
    )
    for (const [minQty, sell, internal] of rows) ins.run(COMBO1, 'A4', minQty, sell, internal)
  }

  it('未配阶梯：传 quantity 不改基础价（回落 combo_prices）', () => {
    expect(quote(db, 1, 1, 'A4', { quantity: 1000 })?.sell_c).toBe(7)
  })

  it('取 min_qty ≤ quantity 的最高档；低于首档 / 缺省 quantity 回落基础价', () => {
    setTiers([
      [100, 10, null],
      [500, 3, null],
    ])
    expect(quote(db, 1, 1, 'A4')?.sell_c).toBe(7) // 缺省 quantity → 基础价
    expect(quote(db, 1, 1, 'A4', { quantity: 1 })?.sell_c).toBe(7) // qty 1 永不命中
    expect(quote(db, 1, 1, 'A4', { quantity: 99 })?.sell_c).toBe(7) // 未达首档
    expect(quote(db, 1, 1, 'A4', { quantity: 100 })?.sell_c).toBe(10) // 命中 100 档
    expect(quote(db, 1, 1, 'A4', { quantity: 499 })?.sell_c).toBe(10)
    expect(quote(db, 1, 1, 'A4', { quantity: 500 })?.sell_c).toBe(3) // 命中 500 档
    expect(quote(db, 1, 1, 'A4', { quantity: 99999 })?.sell_c).toBe(3)
  })

  it('阶梯价同走 D8 决策：below_margin / LOSS（force OFF），禁止静默抬价', () => {
    setTiers([
      [100, 10, null], // total 6 ≤ 10 < auto 19 → below_margin
      [500, 3, null], // 3 < total 6 → LOSS
    ])
    expect(quote(db, 1, 1, 'A4', { quantity: 100 })?.flag).toBe('below_margin')
    const loss = quote(db, 1, 1, 'A4', { quantity: 500 })
    expect(loss?.sell_c).toBe(3)
    expect(loss?.flag).toBe('LOSS')
    expect(loss?.source).toBe('manual')
  })

  it('force_min_margin 开：阶梯价 < 地板价 → 抬至地板（forced）', () => {
    setTiers([[100, 10, null]])
    db.prepare('UPDATE system_config SET force_min_margin = 1 WHERE id = 1').run()
    invalidateConfigCache()
    const q = quote(db, 1, 1, 'A4', { quantity: 100 })
    expect(q?.sell_c).toBe(19)
    expect(q?.flag).toBe('forced')
  })

  it('internal 取 internal_sell_c ?? sell_c（同 combo_prices 口径）', () => {
    setTiers([
      [100, 10, 8], // 内部档价 8
      [500, 3, null], // 内部缺省 → 回落档内 sell_c 3
    ])
    expect(quote(db, 1, 1, 'A4', { quantity: 100 })?.sell_c).toBe(10)
    expect(quote(db, 1, 1, 'A4', { quantity: 100, internal: true })?.sell_c).toBe(8)
    expect(quote(db, 1, 1, 'A4', { quantity: 500, internal: true })?.sell_c).toBe(3)
  })

  it('阶梯不进 catalog：listQuotable 仍 60（min_qty>1 不新增 qty=1 行，§2.5 基线守恒）', () => {
    setTiers([
      [100, 10, null],
      [500, 3, null],
    ])
    expect(listQuotable(db).length).toBe(60)
  })
})
