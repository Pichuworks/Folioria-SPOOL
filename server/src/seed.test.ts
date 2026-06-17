import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DB } from './db.js'
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

  it('PRD §9 数量基线：6 尺寸 · 5 打印机 · 16 模式 · 13 纸张 · 38 采购口径 · 70 组合 · 1 耗材', () => {
    expect(count('sizes')).toBe(6)
    expect(count('printers')).toBe(5)
    expect(count('print_modes')).toBe(16)
    expect(count('papers')).toBe(13)
    expect(count('paper_size_costs')).toBe(38)
    expect(count('combos')).toBe(70)
    expect(count('consumables')).toBe(1)
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

  it('§2.5 结构基线：可报价组合（三条件）= 187，其中手动价 43，自动 144', () => {
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
    expect(eligible).toBe(187)

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
    expect(manual).toBe(43)
    expect(eligible - manual).toBe(144)
  })

  it('金额原样落库：mode 1 ink_price_c=140000 · 设备 C850 equipment_cost_c=2060000 · 耗材 unit_cost_c=140000', () => {
    const mode = db
      .prepare('SELECT ink_price_c, yield_sheets FROM print_modes WHERE id = 1')
      .get() as { ink_price_c: number; yield_sheets: number }
    expect(mode).toEqual({ ink_price_c: 140000, yield_sheets: 56000 })

    const printer = db
      .prepare("SELECT equipment_cost_c, monthly_cost_c FROM printers WHERE code = 'C850'")
      .get() as { equipment_cost_c: number; monthly_cost_c: number }
    expect(printer).toEqual({ equipment_cost_c: 2060000, monthly_cost_c: 50000 })

    const consumable = db
      .prepare('SELECT unit_cost_c, quantity, current_usage_pages, cost_model FROM consumables')
      .get() as {
      unit_cost_c: number
      quantity: number
      current_usage_pages: number
      cost_model: string
    }
    expect(consumable).toEqual({
      unit_cost_c: 140000,
      quantity: 1,
      current_usage_pages: 0,
      cost_model: 'per_page',
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
})
