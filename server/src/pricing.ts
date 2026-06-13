import { type DB } from './db.js'
import { moneyC, roundHalfUp, type MoneyC } from './money.js'

export interface QuoteOptions {
  internal?: boolean
}

export interface Quote {
  mode_id: number
  paper_id: number
  size_key: string
  ink_c: MoneyC
  paper_c: MoneyC
  total_c: MoneyC
  auto_sell_c: MoneyC
  sell_c: MoneyC
  source: 'auto' | 'manual'
  flag: 'auto' | 'manual' | 'below_margin' | 'LOSS' | 'forced'
}

/** 整数对整数走精确 divmod half-up；REAL 面积参与时回落 roundHalfUp(num/den)（§2.3 公式钦定舍入点） */
function divRoundHalfUp(num: number, den: number): number {
  if (!(den > 0) || num < 0) throw new RangeError(`divRoundHalfUp: invalid ${num}/${den}`)
  if (Number.isSafeInteger(num) && Number.isSafeInteger(den)) {
    const rem = num % den
    const base = (num - rem) / den
    return rem * 2 >= den ? base + 1 : base
  }
  return roundHalfUp(num / den)
}

/** 自动地板价钦定 ceil（§2.3）：正整数精确 */
function ceilDiv(num: number, den: number): number {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num < 0 || den <= 0) {
    throw new RangeError(`ceilDiv: invalid ${num}/${den}`)
  }
  const rem = num % den
  return (num - rem) / den + (rem > 0 ? 1 : 0)
}

interface PricingConfig {
  min_margin_bp: number
  force_min_margin: number
  overhead_dep_months: number
  overhead_month_volume: number
}

function getConfig(db: DB): PricingConfig {
  const cfg = db
    .prepare(
      'SELECT min_margin_bp, force_min_margin, overhead_dep_months, overhead_month_volume FROM system_config WHERE id = 1',
    )
    .get() as PricingConfig | undefined
  if (!cfg) throw new Error('pricing: system_config missing (run spool init)')
  return cfg
}

interface CostRow {
  pricing_mode: string
  ink_price_c: number
  ml_per_batch: number | null
  yield_sheets: number
  ref_area: number
  max_area: number
  size_area: number
  pack_price_c: number | null
  pack_count: number | null
}

export interface UnitCost {
  ink_c: MoneyC
  paper_c: MoneyC
  total_c: MoneyC
}

/** §2.3 单张成本推导（不要求 combo 存在——内部作业也要核算）。尺寸越界/无采购口径 → null */
export function deriveUnitCost(
  db: DB,
  modeId: number,
  paperId: number,
  sizeKey: string,
): UnitCost | null {
  const row = db
    .prepare(
      `SELECT m.pricing_mode, m.ink_price_c, m.ml_per_batch, m.yield_sheets,
              rs.area AS ref_area, mx.area AS max_area, s.area AS size_area,
              psc.pack_price_c, psc.pack_count
       FROM print_modes m
       JOIN sizes rs ON rs.key = m.ref_size
       JOIN sizes mx ON mx.key = m.max_size
       JOIN sizes s ON s.key = @size
       LEFT JOIN paper_size_costs psc ON psc.paper_id = @paper AND psc.size_key = @size
       WHERE m.id = @mode AND m.archived = 0`,
    )
    .get({ mode: modeId, paper: paperId, size: sizeKey }) as CostRow | undefined

  if (!row) return null
  if (row.size_area > row.max_area) return null
  if (row.pack_price_c == null || row.pack_count == null) return null
  if (row.pricing_mode === 'ml' && row.ml_per_batch == null) {
    throw new Error(`pricing: mode ${modeId} pricing_mode=ml requires ml_per_batch`)
  }
  const effInk =
    row.pricing_mode === 'ml' ? row.ink_price_c * (row.ml_per_batch as number) : row.ink_price_c
  const ink = divRoundHalfUp(effInk * row.size_area, row.yield_sheets * row.ref_area)
  const paper = divRoundHalfUp(row.pack_price_c, row.pack_count)
  return { ink_c: moneyC(ink), paper_c: moneyC(paper), total_c: moneyC(ink + paper) }
}

/** 可选性三条件 + §2.3 推导。不可选 → null（API 层转 404） */
export function quote(
  db: DB,
  modeId: number,
  paperId: number,
  sizeKey: string,
  opts?: QuoteOptions,
): Quote | null {
  const comboRow = db
    .prepare(
      `SELECT cp.sell_c, cp.internal_sell_c
       FROM combos c
       JOIN papers p ON p.id = c.paper_id AND p.archived = 0
       LEFT JOIN combo_prices cp ON cp.combo_id = c.id AND cp.size_key = @size
       WHERE c.mode_id = @mode AND c.paper_id = @paper AND c.archived = 0`,
    )
    .get({ mode: modeId, paper: paperId, size: sizeKey }) as
    | { sell_c: number | null; internal_sell_c: number | null }
    | undefined
  if (!comboRow) return null

  const cost = deriveUnitCost(db, modeId, paperId, sizeKey)
  if (!cost) return null
  const ink: number = cost.ink_c
  const paper: number = cost.paper_c
  const total: number = cost.total_c

  const cfg = getConfig(db)
  const auto = ceilDiv(total * 10000, 10000 - cfg.min_margin_bp)

  const manual = opts?.internal
    ? (comboRow.internal_sell_c ?? comboRow.sell_c)
    : comboRow.sell_c

  let sell: number
  let source: Quote['source']
  let flag: Quote['flag']
  if (manual == null) {
    sell = auto
    source = 'auto'
    flag = 'auto'
  } else if (cfg.force_min_margin !== 0 && manual < auto) {
    sell = auto
    source = 'manual'
    flag = 'forced'
  } else {
    // D8: 手动价无条件生效，低毛利/亏本只警示，禁止静默抬价
    sell = manual
    source = 'manual'
    flag = manual < total ? 'LOSS' : manual < auto ? 'below_margin' : 'manual'
  }

  return {
    mode_id: modeId,
    paper_id: paperId,
    size_key: sizeKey,
    ink_c: moneyC(ink),
    paper_c: moneyC(paper),
    total_c: moneyC(total),
    auto_sell_c: moneyC(auto),
    sell_c: moneyC(sell),
    source,
    flag,
  }
}

/** 全部可选组合（三条件 SQL 同 quote 语义）按 combo id × size sort 序 */
export function listQuotable(db: DB, opts?: QuoteOptions): Quote[] {
  const rows = db
    .prepare(
      `SELECT c.mode_id, c.paper_id, s.key AS size_key
       FROM combos c
       JOIN print_modes m ON m.id = c.mode_id AND m.archived = 0
       JOIN papers p ON p.id = c.paper_id AND p.archived = 0
       JOIN sizes mx ON mx.key = m.max_size
       JOIN sizes s ON s.area <= mx.area
       JOIN paper_size_costs psc ON psc.paper_id = c.paper_id AND psc.size_key = s.key
       WHERE c.archived = 0
       ORDER BY c.id, s.sort`,
    )
    .all() as Array<{ mode_id: number; paper_id: number; size_key: string }>

  const quotes: Quote[] = []
  for (const r of rows) {
    const q = quote(db, r.mode_id, r.paper_id, r.size_key, opts)
    if (q) quotes.push(q)
  }
  return quotes
}

export interface Product {
  category: string // bw | color | photo-value | photo-premium | photo-art
  tech: string // laser | inkjet（照片档客户不选，由品质档决定）
  paper_id: number
  size_key: string
  duplex: number
  sell_c: MoneyC
  mode_id: number // 该产品最便宜的可做模式（下单绑定 + admin 可改派）
}

/**
 * ③⑤ 客户产品视图：把可报价 (mode,paper,size) 按「色彩档 × 技术 × 纸 × 尺寸 × 单双面」折叠，
 * 取最低售价 + 对应最便宜模式（机器对客户不可见）。color_class 多值（如 'bw,color'）= 同时归多档。
 * combos/价不变 → §2.5 stored 基线(187/43)不动，这是叠加的展示层。
 */
export function listProducts(db: DB, opts?: QuoteOptions): Product[] {
  const rows = db
    .prepare(
      `SELECT c.mode_id, c.paper_id, s.key AS size_key, m.duplex,
              COALESCE(m.color_class, 'color') AS color_class, pr.type AS tech
       FROM combos c
       JOIN print_modes m ON m.id = c.mode_id AND m.archived = 0
       JOIN printers pr ON pr.id = m.printer_id AND pr.archived = 0
       JOIN papers p ON p.id = c.paper_id AND p.archived = 0
       JOIN sizes mx ON mx.key = m.max_size
       JOIN sizes s ON s.area <= mx.area
       JOIN paper_size_costs psc ON psc.paper_id = c.paper_id AND psc.size_key = s.key
       WHERE c.archived = 0`,
    )
    .all() as Array<{
    mode_id: number
    paper_id: number
    size_key: string
    duplex: number
    color_class: string
    tech: string
  }>

  const map = new Map<string, Product>()
  for (const r of rows) {
    const q = quote(db, r.mode_id, r.paper_id, r.size_key, opts)
    if (!q) continue
    for (const category of r.color_class.split(',')) {
      const key = [category, r.tech, r.paper_id, r.size_key, r.duplex].join('|')
      const cur = map.get(key)
      if (!cur || (q.sell_c as number) < (cur.sell_c as number)) {
        map.set(key, {
          category,
          tech: r.tech,
          paper_id: r.paper_id,
          size_key: r.size_key,
          duplex: r.duplex,
          sell_c: q.sell_c,
          mode_id: r.mode_id,
        })
      }
    }
  }
  return [...map.values()]
}

/** 折旧摊薄（§2.3）：round(equipment_cost_c ÷ (dep_months × month_volume))。不计入报价 total_c，T12 成本快照用 */
export function overheadC(db: DB, printerId: number): MoneyC {
  const printer = db
    .prepare('SELECT equipment_cost_c FROM printers WHERE id = ?')
    .get(printerId) as { equipment_cost_c: number } | undefined
  if (!printer) throw new Error(`pricing: unknown printer ${printerId}`)
  const cfg = getConfig(db)
  return moneyC(
    divRoundHalfUp(printer.equipment_cost_c, cfg.overhead_dep_months * cfg.overhead_month_volume),
  )
}
