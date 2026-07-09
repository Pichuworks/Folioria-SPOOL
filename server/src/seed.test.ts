import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { formatMoney, formatMoneyC, lineTotal } from './money.js'
import { quote } from './pricing.js'
import { importSeed } from './seed.js'
import { makeTestDb, withSystemConfig } from './test-helpers.js'

describe('seed 导入（data/seed.json，金额已是 _c 整数，禁止换算）', () => {
  let db: DB
  beforeEach(() => {
    db = makeTestDb()
    withSystemConfig(db)
    importSeed(db)
  })
  afterEach(() => {
    db.close()
  })

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n

  it('PRD §9 数量基线：7 尺寸 · 5 打印机 · 16 模式 · 50 纸张 · 50 采购口径 · 70 组合 · 1 耗材', () => {
    expect(count('sizes')).toBe(7)
    expect(count('printers')).toBe(5)
    expect(count('print_modes')).toBe(16)
    expect(count('papers')).toBe(50)
    expect(count('paper_size_costs')).toBe(50)
    expect(count('combos')).toBe(70)
    expect(count('consumables')).toBe(1)
  })

  it('纸张属性字段随 seed 原样落库', () => {
    const paper = db
      .prepare('SELECT name, category, gsm, supplier, notes, color_tag FROM papers WHERE id = 1')
      .get() as Record<string, unknown>

    expect(paper).toEqual({
      name: '亚太森博 A4',
      category: 'plain',
      gsm: 80,
      supplier: '亚太森博',
      notes: 'source=纸种.xlsx row=6',
      color_tag: 'bond',
    })
  })
  it('PRD §9：20 组合带手动定价 / 50 纯自动', () => {
    const manualCombos = (
      db
        .prepare(
          'SELECT COUNT(DISTINCT combo_id) n FROM combo_prices WHERE sell_c IS NOT NULL',
        )
        .get() as { n: number }
    ).n
    expect(manualCombos).toBe(20)
  })

  it('§2.5 结构基线：可报价组合（三条件）= 60，其中手动价 13，自动 47', () => {
    const eligible = (
      db
        .prepare(
          `SELECT COUNT(*) n FROM combos c
           JOIN print_modes m ON m.id = c.mode_id
           JOIN sizes ms ON ms.key = m.max_size
           JOIN sizes s ON s.area <= ms.area
           JOIN paper_size_costs psc ON psc.paper_id = c.paper_id AND psc.size_key = s.key`,
        )
        .get() as { n: number }
    ).n
    expect(eligible).toBe(60)

    const manual = (
      db
        .prepare(
          `SELECT COUNT(*) n FROM combos c
           JOIN print_modes m ON m.id = c.mode_id
           JOIN sizes ms ON ms.key = m.max_size
           JOIN sizes s ON s.area <= ms.area
           JOIN paper_size_costs psc ON psc.paper_id = c.paper_id AND psc.size_key = s.key
           JOIN combo_prices cp ON cp.combo_id = c.id AND cp.size_key = s.key
           WHERE cp.sell_c IS NOT NULL`,
        )
        .get() as { n: number }
    ).n
    expect(manual).toBe(13)
    expect(eligible - manual).toBe(47)
  })

  it('金额原样落库：mode 1 ink_price_c=14000000 · 设备 C850 equipment_cost_c=206000000 · 耗材 unit_cost_c=14000000', () => {
    const mode = db
      .prepare('SELECT ink_price_c, yield_sheets FROM print_modes WHERE id = 1')
      .get() as { ink_price_c: number; yield_sheets: number }
    expect(mode).toEqual({ ink_price_c: 14000000, yield_sheets: 56000 })

    const printer = db
      .prepare("SELECT equipment_cost_c, monthly_cost_c FROM printers WHERE code = 'C850'")
      .get() as { equipment_cost_c: number; monthly_cost_c: number }
    expect(printer).toEqual({ equipment_cost_c: 206000000, monthly_cost_c: 5000000 })

    const consumable = db
      .prepare('SELECT unit_cost_c, quantity, current_usage_pages, cost_model FROM consumables')
      .get() as {
      unit_cost_c: number
      quantity: number
      current_usage_pages: number
      cost_model: string
    }
    expect(consumable).toEqual({
      unit_cost_c: 14000000,
      quantity: 1,
      current_usage_pages: 0,
      cost_model: 'per_page',
    })
  })

  it('耗材成本口径：C850按1400/套，G580/L15168按250/套，P708表格低成本只落到灌装模式', () => {
    const modes = db
      .prepare(
        `SELECT id, name, ink_price_c, ml_per_batch, yield_sheets
         FROM print_modes
         WHERE id IN (7, 8, 9, 10, 11, 14)
         ORDER BY id`,
      )
      .all() as Array<{
      id: number
      name: string
      ink_price_c: number
      ml_per_batch: number | null
      yield_sheets: number
    }>

    expect(modes).toEqual([
      { id: 7, name: 'P708 原装', ink_price_c: 25000000, ml_per_batch: 250, yield_sheets: 110 },
      { id: 8, name: 'P708 灌装', ink_price_c: 10000, ml_per_batch: 1000, yield_sheets: 440 },
      { id: 9, name: 'G580', ink_price_c: 2500000, ml_per_batch: 360, yield_sheets: 1300 },
      { id: 10, name: 'L15168 照片', ink_price_c: 2500000, ml_per_batch: 200, yield_sheets: 175 },
      { id: 11, name: 'L15168 文档·单', ink_price_c: 2500000, ml_per_batch: 200, yield_sheets: 1500 },
      { id: 14, name: 'L15168 文档·双', ink_price_c: 2500000, ml_per_batch: 200, yield_sheets: 750 },
    ])

    const consumable = db.prepare('SELECT unit_cost_c, rated_life_pages FROM consumables').get() as {
      unit_cost_c: number
      rated_life_pages: number
    }
    expect(consumable).toEqual({
      unit_cost_c: 14000000,
      rated_life_pages: 56000,
    })
  })

  it('printer_code → printer_id 映射正确（耗材挂 C850，mode 9 挂 G580）', () => {
    const c850 = db.prepare("SELECT id FROM printers WHERE code = 'C850'").get() as { id: number }
    const consumablePrinter = db.prepare('SELECT printer_id FROM consumables').get() as {
      printer_id: number
    }
    expect(consumablePrinter.printer_id).toBe(c850.id)

    const g580 = db.prepare("SELECT id FROM printers WHERE code = 'G580'").get() as { id: number }
    const mode9 = db.prepare('SELECT printer_id, max_size FROM print_modes WHERE id = 9').get() as {
      printer_id: number
      max_size: string
    }
    expect(mode9.printer_id).toBe(g580.id)
    expect(mode9.max_size).toBe('A4')
  })

  it('settings 同步进 system_config', () => {
    const cfg = db
      .prepare(
        'SELECT min_margin_bp, unify_pricing, force_min_margin, overhead_dep_months, overhead_month_volume FROM system_config WHERE id = 1',
      )
      .get() as Record<string, number>
    expect(cfg).toEqual({
      min_margin_bp: 6700,
      unify_pricing: 1,
      force_min_margin: 0,
      overhead_dep_months: 36,
      overhead_month_volume: 2000,
    })
  })

  it('重复导入被拒绝（已 seed 的库不可二次导入）', () => {
    expect(() => importSeed(db)).toThrow(/already seeded/i)
  })

  it('未 init（无 system_config）→ 拒绝导入且整体回滚', () => {
    const fresh = makeTestDb()
    expect(() => importSeed(fresh)).toThrow(/spool init/i)
    expect((fresh.prepare('SELECT COUNT(*) n FROM sizes').get() as { n: number }).n).toBe(0)
    fresh.close()
  })

  it('CNY 单价层按“分×100”落库：A4 黑白手动 7 分/张，1000 张合计 70 元', () => {
    const cny = makeTestDb()
    try {
      withSystemConfig(cny, 'CNY')
      importSeed(cny)

      const currency = baseCurrency(cny)
      const q = quote(cny, 1, 1, 'A4')
      expect(q).not.toBeNull()
      expect(q?.sell_c).toBe(700)
      expect(formatMoneyC(q!.sell_c, currency)).toBe('￥0.07')
      expect(formatMoney(lineTotal(q!.sell_c, 1000), currency)).toBe('￥70.00')
    } finally {
      cny.close()
    }
  })
})
