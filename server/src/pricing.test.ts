import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DB } from './db.js'
import { invalidateConfigCache, invalidateQuotableCache, listProducts, listQuotable, overheadC, quote } from './pricing.js'
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
      ['A', 6, 6, 'A3', 5571, 1629, 7200],
      ['B', 1, 1, 'A4', 250, 317, 567],
      ['C', 7, 11, 'A3', 227273, 24635, 251908],
      ['D', 6, 8, 'A4', 2800, 2883, 5683],
    ]
  it.each(vectors)('用例 %s: mode %i × paper %i @ %s → ink %i + paper %i = %i', (_label, m, p, s, ink, paper, total) => {
    const q = quote(db, m, p, s)
    expect(q).not.toBeNull()
    expect(q?.ink_c).toBe(ink)
    expect(q?.paper_c).toBe(paper)
    expect(q?.total_c).toBe(total)
  })

  it('ml 计价分支：mode 8 P708灌装 eff = 10000 × 1000 = 10000000_c → ink@A3 = 22727', () => {
    const q = quote(db, 8, 11, 'A3')
    expect(q?.ink_c).toBe(22727)
    expect(q?.paper_c).toBe(24635)
    expect(q?.total_c).toBe(47362)
  })

  it('overhead_c：C850 = round(206000000 / (36×2000)) = 2861（不计入报价 total_c）', () => {
    const c850 = db.prepare("SELECT id FROM printers WHERE code = 'C850'").get() as { id: number }
    expect(overheadC(db, c850.id)).toBe(2861)
  })
})
describe('§2.2 自动地板价（ceil，永不击穿 67%）', () => {
  const vectors: ReadonlyArray<readonly [number, number, string, number, number]> = [
    [6, 6, 'A3', 7200, 21819],
    [1, 1, 'A4', 567, 1719],
    [6, 8, 'A4', 5683, 17222],
    [7, 11, 'A3', 251908, 763358],
  ]
  it.each(vectors)('mode %i × paper %i @ %s: total %i → auto %i', (m, p, s, total, auto) => {
    const q = quote(db, m, p, s)
    expect(q?.total_c).toBe(total)
    expect(q?.auto_sell_c).toBe(auto)
  })

  it('性质：全部 672 组合 (auto−total)×10000 ≥ 6700×auto（整数精确，不经浮点）', () => {
    const all = listQuotable(db)
    expect(all.length).toBe(672)
    for (const q of all) {
      expect((q.auto_sell_c - q.total_c) * 10000).toBeGreaterThanOrEqual(6700 * q.auto_sell_c)
    }
  })
})

describe('§2.3 报价规则（D8 防翻案：手动价生效并警示，禁止静默抬价）', () => {
  it('force OFF（默认）：彩图×哑光铜版纸 A3 手动 9000 → sell 9000，below_margin', () => {
    const q = quote(db, 6, 6, 'A3')
    expect(q?.sell_c).toBe(9000)
    expect(q?.auto_sell_c).toBe(21819)
    expect(q?.source).toBe('manual')
    expect(q?.flag).toBe('below_margin')
  })

  it('force OFF：P708原装×RC艺术纸 A3 手动 250000 < total 251908 → sell 250000，LOSS', () => {
    const q = quote(db, 7, 11, 'A3')
    expect(q?.sell_c).toBe(250000)
    expect(q?.auto_sell_c).toBe(763358)
    expect(q?.flag).toBe('LOSS')
  })

  it('force OFF：G580×珠光纸 6寸 手动 15000 → sell 15000，below_margin', () => {
    const q = quote(db, 10, 12, '6')
    expect(q?.sell_c).toBe(15000)
    expect(q?.auto_sell_c).toBe(19007)
    expect(q?.flag).toBe('below_margin')
  })

  it('force OFF：黑白×金华盛 A4 无手动 → sell 2876，auto', () => {
    const q = quote(db, 1, 3, 'A4')
    expect(q?.sell_c).toBe(2876)
    expect(q?.auto_sell_c).toBe(2876)
    expect(q?.source).toBe('auto')
    expect(q?.flag).toBe('auto')
  })

  it('force ON：黑白×亚太森博 A4 → sell 1719，forced', () => {
    db.prepare('UPDATE system_config SET force_min_margin = 1 WHERE id = 1').run()
    invalidateConfigCache()
    const q = quote(db, 1, 1, 'A4')
    expect(q?.sell_c).toBe(1719)
    expect(q?.flag).toBe('forced')
  })

  it('手动价 ≥ 地板价 → 正常 manual，无警示', () => {
    db.prepare("UPDATE combo_prices SET sell_c = 6000 WHERE combo_id = 1 AND size_key = 'A4'").run()
    const q = quote(db, 1, 1, 'A4')
    expect(q?.sell_c).toBe(6000)
    expect(q?.flag).toBe('manual')
  })

  it('内部价覆盖（B1.1）：internal_sell_c 生效，缺省回落对外逻辑', () => {
    expect(quote(db, 1, 1, 'A4', { internal: true })?.sell_c).toBe(700)
    db.prepare(
      "UPDATE combo_prices SET internal_sell_c = 1000 WHERE combo_id = 1 AND size_key = 'A4'",
    ).run()
    expect(quote(db, 1, 1, 'A4', { internal: true })?.sell_c).toBe(1000)
    expect(quote(db, 1, 1, 'A4')?.sell_c).toBe(700)
  })
})

describe('§2.4 可选性三条件（任一不满足 → null，API 层转 404）', () => {
  it('mode 9 G580(max=A4) × paper 1 @ A3 → 尺寸越界', () => {
    expect(quote(db, 9, 1, 'A3')).toBeNull()
  })

  it('纸张没有任何可用采购来源 → null', () => {
    db.prepare('DELETE FROM paper_size_costs WHERE paper_id = 7').run()
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

describe('D43 开纸换算报价', () => {
  it('A4 原纸可按 2 开报价 A5，成本与来源均为整数快照', () => {
    const q = quote(db, 1, 1, 'A5')
    expect(q).not.toBeNull()
    expect(q?.paper_c).toBe(159)
    expect(q?.paper_source_size_key).toBe('A4')
    expect(q?.paper_yield).toBe(2)
    expect(Number.isSafeInteger(q?.paper_c)).toBe(true)
  })

  it('同纸同时存在 A4/A3 来源时，按精确有效单张成本选择最低来源', () => {
    db.prepare(
      "INSERT INTO paper_size_costs (paper_id, size_key, pack_price_c, pack_count) VALUES (1, 'A3', 1000, 10)",
    ).run()
    const q = quote(db, 1, 1, 'A5')
    expect(q?.paper_c).toBe(25)
    expect(q?.paper_source_size_key).toBe('A3')
    expect(q?.paper_yield).toBe(4)
  })

  it('打印机上限按源纸尺寸判断：A3 原纸不能进入 max=A4 的模式', () => {
    expect(quote(db, 12, 2, 'A5')).toBeNull()
  })

  it('产品目录包含派生 A5，完整尺寸目录不会凭空制造无产品尺寸', () => {
    invalidateQuotableCache()
    const products = listProducts(db)
    expect(products.some((p) => p.paper_id === 1 && p.size_key === 'A5' && p.category === 'bw')).toBe(true)
    expect(products.some((p) => p.size_key === 'A0')).toBe(false)
  })
})

describe('§2.5 全量回归基线（seed 或公式改动后变化须人工确认）', () => {
  it('672 可报价：手动 31（LOSS 4 / below_margin 18 / 正常 9）；自动 641；sell_c 全为正整数', () => {
    const all = listQuotable(db)
    expect(all.length).toBe(672)

    const manual = all.filter((q) => q.source === 'manual')
    const auto = all.filter((q) => q.source === 'auto')
    expect(manual.length).toBe(31)
    expect(auto.length).toBe(641)

    expect(manual.filter((q) => q.flag === 'LOSS').length).toBe(4)
    expect(manual.filter((q) => q.flag === 'below_margin').length).toBe(18)
    expect(manual.filter((q) => q.flag === 'manual').length).toBe(9)

    for (const q of all) {
      expect(Number.isSafeInteger(q.sell_c)).toBe(true)
      expect(q.sell_c).toBeGreaterThan(0)
    }
  })
})

describe('quote() 与 listQuotable/deriveQuoteFromRow 逐行等价（review M6：防两份 D8 实现漂移）', () => {
  it('每个可报价组合：单查 quote() 与批量行 ink/paper/total/auto/sell/source/flag 全等', () => {
    const all = listQuotable(db)
    expect(all.length).toBe(672)
    for (const row of all) {
      const q = quote(db, row.mode_id, row.paper_id, row.size_key)
      if (!q) throw new Error(`quote null: ${row.mode_id}/${row.paper_id}/${row.size_key}`)
      expect({
        ink_c: q.ink_c, paper_c: q.paper_c, total_c: q.total_c,
        auto_sell_c: q.auto_sell_c, sell_c: q.sell_c, source: q.source, flag: q.flag,
        paper_source_size_key: q.paper_source_size_key, paper_yield: q.paper_yield,
      }).toEqual({
        ink_c: row.ink_c, paper_c: row.paper_c, total_c: row.total_c,
        auto_sell_c: row.auto_sell_c, sell_c: row.sell_c, source: row.source, flag: row.flag,
        paper_source_size_key: row.paper_source_size_key, paper_yield: row.paper_yield,
      })
    }
  })
})

describe('数量阶梯定价（D38 · combo_price_tiers）', () => {
  // combo 1 = (mode 1, paper 1)；A4 基础手动价 700、total 567、auto 1719
  const COMBO1 = 1
  function setTiers(rows: ReadonlyArray<readonly [number, number, number | null]>): void {
    const ins = db.prepare(
      'INSERT INTO combo_price_tiers (combo_id, size_key, min_qty, sell_c, internal_sell_c) VALUES (?, ?, ?, ?, ?)',
    )
    for (const [minQty, sell, internal] of rows) ins.run(COMBO1, 'A4', minQty, sell, internal)
  }

  it('未配阶梯：传 quantity 不改基础价（回落 combo_prices）', () => {
    expect(quote(db, 1, 1, 'A4', { quantity: 1000 })?.sell_c).toBe(700)
  })

  it('取 min_qty ≤ quantity 的最高档；低于首档 / 缺省 quantity 回落基础价', () => {
    setTiers([
      [100, 1000, null],
      [500, 300, null],
    ])
    expect(quote(db, 1, 1, 'A4')?.sell_c).toBe(700) // 缺省 quantity → 基础价
    expect(quote(db, 1, 1, 'A4', { quantity: 1 })?.sell_c).toBe(700) // qty 1 永不命中
    expect(quote(db, 1, 1, 'A4', { quantity: 99 })?.sell_c).toBe(700) // 未达首档
    expect(quote(db, 1, 1, 'A4', { quantity: 100 })?.sell_c).toBe(1000) // 命中 100 档
    expect(quote(db, 1, 1, 'A4', { quantity: 499 })?.sell_c).toBe(1000)
    expect(quote(db, 1, 1, 'A4', { quantity: 500 })?.sell_c).toBe(300) // 命中 500 档
    expect(quote(db, 1, 1, 'A4', { quantity: 99999 })?.sell_c).toBe(300)
  })

  it('阶梯价同走 D8 决策：below_margin / LOSS（force OFF），禁止静默抬价', () => {
    setTiers([
      [100, 1000, null], // total 567 ≤ 1000 < auto 1719 → below_margin
      [500, 300, null], // 300 < total 567 → LOSS
    ])
    expect(quote(db, 1, 1, 'A4', { quantity: 100 })?.flag).toBe('below_margin')
    const loss = quote(db, 1, 1, 'A4', { quantity: 500 })
    expect(loss?.sell_c).toBe(300)
    expect(loss?.flag).toBe('LOSS')
    expect(loss?.source).toBe('manual')
  })

  it('force_min_margin 开：阶梯价 < 地板价 → 抬至地板（forced）', () => {
    setTiers([[100, 1000, null]])
    db.prepare('UPDATE system_config SET force_min_margin = 1 WHERE id = 1').run()
    invalidateConfigCache()
    const q = quote(db, 1, 1, 'A4', { quantity: 100 })
    expect(q?.sell_c).toBe(1719)
    expect(q?.flag).toBe('forced')
  })

  it('internal 取 internal_sell_c ?? sell_c（同 combo_prices 口径）', () => {
    setTiers([
      [100, 1000, 800], // 内部档价 800
      [500, 300, null], // 内部缺省 → 回落档内 sell_c 300
    ])
    expect(quote(db, 1, 1, 'A4', { quantity: 100 })?.sell_c).toBe(1000)
    expect(quote(db, 1, 1, 'A4', { quantity: 100, internal: true })?.sell_c).toBe(800)
    expect(quote(db, 1, 1, 'A4', { quantity: 500, internal: true })?.sell_c).toBe(300)
  })

  it('阶梯不进 catalog：listQuotable 仍 672（min_qty>1 不新增 qty=1 行，§2.5 基线守恒）', () => {
    setTiers([
      [100, 10, null],
      [500, 3, null],
    ])
    expect(listQuotable(db).length).toBe(672)
  })
})
