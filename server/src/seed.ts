import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type DB } from './db.js'

export const SEED_PATH = fileURLToPath(new URL('../../data/seed.json', import.meta.url))

/**
 * ③⑤/D25: 客户色彩档由模式名派生（K 君定调）。文档=黑白彩色皆可；照片分三品质档(按机器)。
 * 不改冻结的 seed.json——在导入器里赋值。同逻辑见 migration 0009（既有实例回填）。
 */
export function classifyColorClass(name: string): string {
  if (name.includes('文档')) return 'bw,color'
  if (name.includes('黑白')) return 'bw'
  if (name.includes('照片')) return 'photo-value' // 性价比
  if (name.includes('G580')) return 'photo-premium' // 高质量
  if (name.includes('P708')) return 'photo-art' // 艺术微喷
  return 'color' // 彩文/彩色/彩图/OKI 彩色
}

interface SeedData {
  settings: {
    min_margin_bp: number
    unify_pricing: boolean
    force_min_margin: boolean
    overhead_dep_months: number
    overhead_month_volume: number
  }
  sizes: Array<{ key: string; label: string; area: number; sort: number }>
  printers: Array<{
    code: string
    name: string
    type: string
    equipment_cost_c: number
    monthly_cost_c: number
  }>
  print_modes: Array<{
    id: number
    name: string
    printer_code: string
    ink_type: string
    pricing_mode: string
    ink_price_c: number
    ml_per_batch: number | null
    yield_sheets: number
    ref_size: string
    max_size: string
    duplex: boolean
    color_tag: string | null
  }>
  papers: Array<{ id: number; name: string; color_tag: string | null }>
  paper_size_costs: Array<{
    paper_id: number
    size_key: string
    pack_price_c: number
    pack_count: number
  }>
  combos: Array<{ id: number; mode_id: number; paper_id: number; sell_c: Record<string, number> }>
  consumables: Array<{
    name: string
    type: string
    printer_code: string
    quantity: number
    unit_cost_c: number
    cost_model: string
    rated_life_pages: number | null
    alert_threshold_bp: number
  }>
}

/** data/seed.json → DB。金额已是 _c 整数，禁止任何换算；全程单事务 */
export function importSeed(db: DB, seedPath: string = SEED_PATH): void {
  const seeded = (db.prepare('SELECT COUNT(*) n FROM sizes').get() as { n: number }).n
  if (seeded > 0) throw new Error('importSeed: database already seeded')

  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedData

  for (const m of seed.print_modes) {
    if (m.pricing_mode === 'ml' && m.ml_per_batch == null) {
      throw new Error(`importSeed: mode ${m.id} pricing_mode=ml requires ml_per_batch`)
    }
  }
  for (const c of seed.consumables) {
    if (c.cost_model === 'per_page' && c.rated_life_pages == null) {
      throw new Error(`importSeed: consumable ${c.name} per_page requires rated_life_pages`)
    }
  }

  db.transaction(() => {
    const insertSize = db.prepare(
      'INSERT INTO sizes (key, label, area, sort) VALUES (@key, @label, @area, @sort)',
    )
    for (const s of seed.sizes) insertSize.run(s)

    // D36 标准尺寸物理 mm（seed.json 不含；与 migration 0018 同口径——迁移覆盖既有库，本处覆盖全新 seed 库，
    // 因 migrate 先于 seed 运行、迁移内 UPDATE 在空表无效）。A3+（A3P）因机型而异留 NULL 待 admin 填。
    const STD_SIZE_MM: Record<string, readonly [number, number]> = {
      '6': [152, 102],
      A5: [148, 210],
      A4: [210, 297],
      A3: [297, 420],
      SRA3: [320, 450],
    }
    const setSizeMm = db.prepare('UPDATE sizes SET width_mm = ?, height_mm = ? WHERE key = ?')
    for (const [key, [w, h]] of Object.entries(STD_SIZE_MM)) setSizeMm.run(w, h, key)

    const insertPrinter = db.prepare(
      `INSERT INTO printers (code, name, type, equipment_cost_c, monthly_cost_c)
       VALUES (@code, @name, @type, @equipment_cost_c, @monthly_cost_c)`,
    )
    const printerIdByCode = new Map<string, number>()
    for (const p of seed.printers) {
      const { lastInsertRowid } = insertPrinter.run(p)
      printerIdByCode.set(p.code, Number(lastInsertRowid))
    }
    const printerId = (code: string): number => {
      const id = printerIdByCode.get(code)
      if (id === undefined) throw new Error(`importSeed: unknown printer_code ${code}`)
      return id
    }

    const insertMode = db.prepare(
      `INSERT INTO print_modes (id, name, printer_id, ink_type, pricing_mode, ink_price_c,
                                ml_per_batch, yield_sheets, ref_size, max_size, duplex, color_tag, color_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const m of seed.print_modes) {
      insertMode.run(
        m.id,
        m.name,
        printerId(m.printer_code),
        m.ink_type,
        m.pricing_mode,
        m.ink_price_c,
        m.ml_per_batch,
        m.yield_sheets,
        m.ref_size,
        m.max_size,
        m.duplex ? 1 : 0,
        m.color_tag,
        classifyColorClass(m.name),
      )
    }

    const insertPaper = db.prepare(
      'INSERT INTO papers (id, name, color_tag) VALUES (@id, @name, @color_tag)',
    )
    for (const p of seed.papers) insertPaper.run(p)

    const insertPsc = db.prepare(
      `INSERT INTO paper_size_costs (paper_id, size_key, pack_price_c, pack_count)
       VALUES (@paper_id, @size_key, @pack_price_c, @pack_count)`,
    )
    for (const psc of seed.paper_size_costs) insertPsc.run(psc)

    const insertCombo = db.prepare(
      'INSERT INTO combos (id, mode_id, paper_id) VALUES (@id, @mode_id, @paper_id)',
    )
    const insertComboPrice = db.prepare(
      'INSERT INTO combo_prices (combo_id, size_key, sell_c) VALUES (?, ?, ?)',
    )
    for (const c of seed.combos) {
      insertCombo.run({ id: c.id, mode_id: c.mode_id, paper_id: c.paper_id })
      for (const [sizeKey, sellC] of Object.entries(c.sell_c)) {
        insertComboPrice.run(c.id, sizeKey, sellC)
      }
    }

    const insertConsumable = db.prepare(
      `INSERT INTO consumables (id, name, type, printer_id, quantity, cost_model,
                                rated_life_pages, unit_cost_c, alert_threshold_bp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const c of seed.consumables) {
      insertConsumable.run(
        randomUUID(),
        c.name,
        c.type,
        printerId(c.printer_code),
        c.quantity,
        c.cost_model,
        c.rated_life_pages,
        c.unit_cost_c,
        c.alert_threshold_bp,
      )
    }

    const { changes } = db
      .prepare(
        `UPDATE system_config SET min_margin_bp = ?, unify_pricing = ?, force_min_margin = ?,
                                  overhead_dep_months = ?, overhead_month_volume = ?
         WHERE id = 1`,
      )
      .run(
        seed.settings.min_margin_bp,
        seed.settings.unify_pricing ? 1 : 0,
        seed.settings.force_min_margin ? 1 : 0,
        seed.settings.overhead_dep_months,
        seed.settings.overhead_month_volume,
      )
    if (changes !== 1) {
      throw new Error('importSeed: system_config missing — run spool init first')
    }
  })()
}
