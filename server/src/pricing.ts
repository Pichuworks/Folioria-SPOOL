import { type DB } from './db.js'
import { getLog } from './logger.js'
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
export function divRoundHalfUp(num: number, den: number): number {
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

let configCache: PricingConfig | null = null

function getConfig(db: DB): PricingConfig {
  if (configCache) return configCache
  const cfg = db
    .prepare(
      'SELECT min_margin_bp, force_min_margin, overhead_dep_months, overhead_month_volume FROM system_config WHERE id = 1',
    )
    .get() as PricingConfig | undefined
  if (!cfg) throw new Error('pricing: system_config missing (run spool init)')
  configCache = cfg
  return cfg
}

export function invalidateConfigCache(): void {
  configCache = null
}

let quotableCache: { normal: Quote[] | null; internal: Quote[] | null } | null = null
let productsCache: { normal: Product[] | null; internal: Product[] | null } | null = null

export function invalidateQuotableCache(): void {
  quotableCache = null
  productsCache = null
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

  if (!row) {
    getLog().debug({ modeId, paperId, sizeKey }, 'deriveUnitCost: mode/size join empty')
    return null
  }
  if (row.size_area > row.max_area) {
    getLog().debug({ modeId, sizeKey, sizeArea: row.size_area, maxArea: row.max_area }, 'deriveUnitCost: size exceeds max')
    return null
  }
  if (row.pack_price_c == null || row.pack_count == null) {
    getLog().debug({ paperId, sizeKey }, 'deriveUnitCost: no paper_size_costs')
    return null
  }
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

interface QuotableRow {
  mode_id: number
  paper_id: number
  size_key: string
  pricing_mode: string
  ink_price_c: number
  ml_per_batch: number | null
  yield_sheets: number
  ref_area: number
  size_area: number
  pack_price_c: number
  pack_count: number
  manual_sell_c: number | null
  internal_sell_c: number | null
}

function deriveQuoteFromRow(r: QuotableRow, cfg: PricingConfig, internal?: boolean): Quote {
  const effInk = r.pricing_mode === 'ml' ? r.ink_price_c * (r.ml_per_batch as number) : r.ink_price_c
  const ink = divRoundHalfUp(effInk * r.size_area, r.yield_sheets * r.ref_area)
  const paper = divRoundHalfUp(r.pack_price_c, r.pack_count)
  const total = ink + paper

  const auto = ceilDiv(total * 10000, 10000 - cfg.min_margin_bp)
  const manual = internal ? (r.internal_sell_c ?? r.manual_sell_c) : r.manual_sell_c

  let sell: number
  let source: Quote['source']
  let flag: Quote['flag']
  if (manual == null) {
    sell = auto; source = 'auto'; flag = 'auto'
  } else if (cfg.force_min_margin !== 0 && manual < auto) {
    sell = auto; source = 'manual'; flag = 'forced'
  } else {
    sell = manual; source = 'manual'
    flag = manual < total ? 'LOSS' : manual < auto ? 'below_margin' : 'manual'
  }

  return {
    mode_id: r.mode_id, paper_id: r.paper_id, size_key: r.size_key,
    ink_c: moneyC(ink), paper_c: moneyC(paper), total_c: moneyC(total),
    auto_sell_c: moneyC(auto), sell_c: moneyC(sell), source, flag,
  }
}

const QUOTABLE_SQL = `
  SELECT c.mode_id, c.paper_id, s.key AS size_key,
         m.pricing_mode, m.ink_price_c, m.ml_per_batch, m.yield_sheets,
         rs.area AS ref_area, s.area AS size_area,
         psc.pack_price_c, psc.pack_count,
         cp.sell_c AS manual_sell_c, cp.internal_sell_c
  FROM combos c
  JOIN print_modes m ON m.id = c.mode_id AND m.archived = 0
  JOIN papers p ON p.id = c.paper_id AND p.archived = 0
  JOIN sizes rs ON rs.key = m.ref_size
  JOIN sizes mx ON mx.key = m.max_size
  JOIN sizes s ON s.area <= mx.area
  JOIN paper_size_costs psc ON psc.paper_id = c.paper_id AND psc.size_key = s.key
  LEFT JOIN combo_prices cp ON cp.combo_id = c.id AND cp.size_key = s.key
  WHERE c.archived = 0
  ORDER BY c.id, s.sort`

/** 全部可选组合（三条件 SQL 同 quote 语义）按 combo id × size sort 序——单条 SQL + JS 侧定价 */
export function listQuotable(db: DB, opts?: QuoteOptions): Quote[] {
  const key = opts?.internal ? 'internal' : 'normal'
  if (quotableCache?.[key] != null) return quotableCache[key]
  const rows = db.prepare(QUOTABLE_SQL).all() as QuotableRow[]
  const cfg = getConfig(db)
  const result = rows.map((r) => deriveQuoteFromRow(r, cfg, opts?.internal))
  if (!quotableCache) quotableCache = { normal: null, internal: null }
  quotableCache[key] = result
  return result
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
  const key = opts?.internal ? 'internal' : 'normal'
  if (productsCache?.[key] != null) return productsCache[key]

  const rows = db
    .prepare(
      `SELECT c.mode_id, c.paper_id, s.key AS size_key, m.duplex,
              COALESCE(m.color_class, 'color') AS color_class, pr.type AS tech,
              m.pricing_mode, m.ink_price_c, m.ml_per_batch, m.yield_sheets,
              rs.area AS ref_area, s.area AS size_area,
              psc.pack_price_c, psc.pack_count,
              cp.sell_c AS manual_sell_c, cp.internal_sell_c
       FROM combos c
       JOIN print_modes m ON m.id = c.mode_id AND m.archived = 0
       JOIN printers pr ON pr.id = m.printer_id AND pr.archived = 0
       JOIN papers p ON p.id = c.paper_id AND p.archived = 0
       JOIN sizes rs ON rs.key = m.ref_size
       JOIN sizes mx ON mx.key = m.max_size
       JOIN sizes s ON s.area <= mx.area
       JOIN paper_size_costs psc ON psc.paper_id = c.paper_id AND psc.size_key = s.key
       LEFT JOIN combo_prices cp ON cp.combo_id = c.id AND cp.size_key = s.key
       WHERE c.archived = 0`,
    )
    .all() as Array<QuotableRow & { duplex: number; color_class: string; tech: string }>

  const cfg = getConfig(db)
  const map = new Map<string, Product>()
  for (const r of rows) {
    const q = deriveQuoteFromRow(r, cfg, opts?.internal)
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
  const result = [...map.values()]
  if (!productsCache) productsCache = { normal: null, internal: null }
  productsCache[key] = result
  return result
}

/**
 * D27 书组件：给定 (color_class, paper, size, duplex)，返回匹配产品里**最低单页 sell_c**
 * 与对应最便宜 mode（机器对客户不可见）。复用 listProducts 折叠口径。不可做 → null。
 * products 可外部预算一次复用（priceBook 逐组件调用，避免重复全目录重算）。
 */
export function priceComponentSpec(
  db: DB,
  spec: { paper_id: number; size_key: string; color_class: string; duplex: number },
  opts?: QuoteOptions,
  products?: readonly Product[],
): { mode_id: number; unit_sell_c: MoneyC } | null {
  const list = products ?? listProducts(db, opts)
  let best: { mode_id: number; sell_c: number } | null = null
  for (const p of list) {
    if (
      p.category === spec.color_class &&
      p.paper_id === spec.paper_id &&
      p.size_key === spec.size_key &&
      p.duplex === spec.duplex &&
      (!best || (p.sell_c as number) < best.sell_c)
    ) {
      best = { mode_id: p.mode_id, sell_c: p.sell_c as number }
    }
  }
  return best ? { mode_id: best.mode_id, unit_sell_c: moneyC(best.sell_c) } : null
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
