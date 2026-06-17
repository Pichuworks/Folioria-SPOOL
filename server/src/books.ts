import { type DB } from './db.js'
import { finishingContribution, type FinishingPricing } from './finishing.js'
import { moneyC, type MoneyC } from './money.js'
import { listProducts, priceComponentSpec, type QuoteOptions } from './pricing.js'

/** 带 statusCode 抛出，由 app 全局 errorHandler 映射为 { error: message } */
export class BookError extends Error {
  public statusCode: number
  constructor(status: number, message: string) {
    super(message)
    this.statusCode = status
  }
}

export type ComponentRole = 'cover' | 'inner' | 'insert'
export type { FinishingPricing } from './finishing.js'

export interface BookComponentRow {
  id: number
  book_id: number
  role: ComponentRole
  paper_id: number
  size_key: string
  color_class: string
  duplex: number
  sort: number
}

export interface PricedBookComponent {
  component_id: number
  role: ComponentRole
  paper_id: number
  size_key: string
  color_class: string
  duplex: number
  sheets_per_book: number
  mode_id: number
  unit_sell_c: MoneyC
}

export interface PricedBookFinishing {
  finishing_id: number
  name: string
  pricing: FinishingPricing
  price_c: MoneyC
  contribution_c: MoneyC
}

export interface BookQuote {
  book_id: number | null
  name: string
  /** 每本售价（含组件 + 工艺），整数定点 _c */
  unit_price_c: MoneyC
  components: PricedBookComponent[]
  finishings: PricedBookFinishing[]
}

/** 下单时一本书的客户输入：本数 + 每组件每本张数（封面忽略=固定 1；内页必填；插图选填） */
export interface BookLineInput {
  book_id: number
  count: number
  /** component_id → 每本张数（封面项忽略） */
  sheets: Record<number, number>
}

/** D36 自定义书册：客户直接指定组件规格（不引用成品定义） */
export interface BookSpecComponent {
  role: ComponentRole
  paper_id: number
  color_class: string
  duplex: number
  sheets_per_book?: number
}

export interface BookSpecInput {
  count: number
  size_key: string
  components: BookSpecComponent[]
  finishing_ids: number[]
}

/**
 * D27 书定价（机器对客户不可见，复用 listProducts 折叠）。每本 unit_price_c =
 *   Σ(组件 unit_sell_c × 每本张数) + Σ(工艺贡献)。
 * 工艺：per_book=price_c · per_page=price_c×每本页数(页=Σ张×(duplex?2:1)，D21 impression 口径)
 *      · per_area=roundHalfUp(price_c×每本纸面积)（面积=Σ size.area×张，REAL 面积仅单价层推导）。
 * 唯一舍入点不在本函数（line_total 在订单层）；本函数仅产 _c 单价快照。
 */
export function priceBook(db: DB, input: BookLineInput, opts?: QuoteOptions): BookQuote {
  const book = db.prepare('SELECT id, name, archived FROM book_products WHERE id = ?').get(input.book_id) as
    | { id: number; name: string; archived: number }
    | undefined
  if (!book || book.archived !== 0) throw new BookError(422, 'book_not_available')

  const comps = db
    .prepare('SELECT * FROM book_components WHERE book_id = ? AND archived = 0 ORDER BY sort, id')
    .all(input.book_id) as BookComponentRow[]
  if (comps.length === 0) throw new BookError(422, 'book_has_no_components')

  // 全目录折叠一次复用（逐组件取匹配规格最低单页价）
  const products = listProducts(db, opts)
  const areaByKey = new Map<string, number>()
  for (const s of db.prepare('SELECT key, area FROM sizes').all() as Array<{ key: string; area: number }>) {
    areaByKey.set(s.key, s.area)
  }

  const priced: PricedBookComponent[] = []
  for (const c of comps) {
    // 每本张数：封面固定 1；内页必填 ≥1；插图选填（缺省 / 0 = 不含，不建组件）
    let sheets: number
    if (c.role === 'cover') {
      sheets = 1
    } else {
      const given = input.sheets[c.id]
      if (c.role === 'inner') {
        if (given == null || given < 1) throw new BookError(422, `inner_sheets_required_${c.id}`)
        sheets = given
      } else {
        if (given == null || given === 0) continue
        if (given < 1) throw new BookError(422, `invalid_sheets_${c.id}`)
        sheets = given
      }
    }
    const resolved = priceComponentSpec(db, c, opts, products)
    if (!resolved) throw new BookError(422, `component_not_quotable_${c.id}`)
    priced.push({
      component_id: c.id,
      role: c.role,
      paper_id: c.paper_id,
      size_key: c.size_key,
      color_class: c.color_class,
      duplex: c.duplex,
      sheets_per_book: sheets,
      mode_id: resolved.mode_id,
      unit_sell_c: resolved.unit_sell_c,
    })
  }
  if (priced.length === 0) throw new BookError(422, 'book_line_empty')

  // 组件材料项（整数 _c/本）
  let unit = 0
  for (const p of priced) unit += (p.unit_sell_c as number) * p.sheets_per_book

  const pagesPerBook = priced.reduce((s, p) => s + p.sheets_per_book * (p.duplex !== 0 ? 2 : 1), 0)
  const areaPerBook = priced.reduce((s, p) => s + (areaByKey.get(p.size_key) ?? 0) * p.sheets_per_book, 0)

  const fins = db
    .prepare(
      `SELECT f.id, f.name, f.pricing, f.price_c
       FROM book_finishings bf JOIN finishing_ops f ON f.id = bf.finishing_id
       WHERE bf.book_id = ? AND f.archived = 0
       ORDER BY f.id`,
    )
    .all(input.book_id) as Array<{ id: number; name: string; pricing: FinishingPricing; price_c: number }>

  const finCtx = { pages: pagesPerBook, area: areaPerBook }
  const finishings: PricedBookFinishing[] = []
  for (const f of fins) {
    const contribution = finishingContribution(f, finCtx) as number
    unit += contribution
    finishings.push({
      finishing_id: f.id,
      name: f.name,
      pricing: f.pricing,
      price_c: moneyC(f.price_c),
      contribution_c: moneyC(contribution),
    })
  }

  if (!Number.isSafeInteger(unit)) throw new BookError(422, 'book_price_overflow')
  return { book_id: book.id, name: book.name, unit_price_c: moneyC(unit), components: priced, finishings }
}

/** D36 自定义书册定价：客户直接指定组件规格 + 工艺，不引用成品。复用 priceComponentSpec 折叠。 */
export function priceBookSpec(db: DB, input: BookSpecInput, opts?: QuoteOptions): BookQuote {
  const size = db.prepare('SELECT key, area, label FROM sizes WHERE key = ?').get(input.size_key) as
    | { key: string; area: number; label: string }
    | undefined
  if (!size) throw new BookError(422, 'invalid_size')

  if (input.components.length === 0) throw new BookError(422, 'no_components')
  const covers = input.components.filter((c) => c.role === 'cover')
  if (covers.length !== 1) throw new BookError(422, 'exactly_one_cover_required')

  const products = listProducts(db, opts)
  const priced: PricedBookComponent[] = []
  const labels: string[] = []

  for (let i = 0; i < input.components.length; i++) {
    const c = input.components[i]!
    let sheets: number
    if (c.role === 'cover') {
      sheets = 1
    } else if (c.role === 'inner') {
      if (c.sheets_per_book == null || c.sheets_per_book < 1) throw new BookError(422, `inner_sheets_required_${i}`)
      sheets = c.sheets_per_book
    } else {
      if (c.sheets_per_book == null || c.sheets_per_book < 1) throw new BookError(422, `insert_sheets_required_${i}`)
      sheets = c.sheets_per_book
    }

    const resolved = priceComponentSpec(db, { paper_id: c.paper_id, size_key: input.size_key, color_class: c.color_class, duplex: c.duplex }, opts, products)
    if (!resolved) throw new BookError(422, `component_not_quotable_${i}`)

    if (c.role !== 'cover') labels.push(`${c.color_class === 'bw' ? '黑白' : '彩色'}${sheets}张`)

    priced.push({
      component_id: 0,
      role: c.role,
      paper_id: c.paper_id,
      size_key: input.size_key,
      color_class: c.color_class,
      duplex: c.duplex,
      sheets_per_book: sheets,
      mode_id: resolved.mode_id,
      unit_sell_c: resolved.unit_sell_c,
    })
  }

  let unit = 0
  for (const p of priced) unit += (p.unit_sell_c as number) * p.sheets_per_book

  const pagesPerBook = priced.reduce((s, p) => s + p.sheets_per_book * (p.duplex !== 0 ? 2 : 1), 0)
  const areaPerBook = priced.reduce((s, p) => s + size.area * p.sheets_per_book, 0)

  const finishings: PricedBookFinishing[] = []
  if (input.finishing_ids.length > 0) {
    const ph = input.finishing_ids.map(() => '?').join(',')
    const fins = db
      .prepare(`SELECT id, name, pricing, price_c FROM finishing_ops WHERE id IN (${ph}) AND archived = 0 ORDER BY id`)
      .all(...input.finishing_ids) as Array<{ id: number; name: string; pricing: FinishingPricing; price_c: number }>
    if (fins.length !== input.finishing_ids.length) throw new BookError(422, 'invalid_finishing')

    const finCtx = { pages: pagesPerBook, area: areaPerBook }
    for (const f of fins) {
      const contribution = finishingContribution(f, finCtx) as number
      unit += contribution
      finishings.push({
        finishing_id: f.id,
        name: f.name,
        pricing: f.pricing,
        price_c: moneyC(f.price_c),
        contribution_c: moneyC(contribution),
      })
    }
  }

  if (!Number.isSafeInteger(unit)) throw new BookError(422, 'book_price_overflow')
  const name = `自定义书册 · ${size.label} · ${labels.join('+')}`
  return { book_id: null, name, unit_price_c: moneyC(unit), components: priced, finishings }
}
