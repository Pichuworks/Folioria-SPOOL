import { randomBytes, randomUUID } from 'node:crypto'
import { priceBook, priceBookSpec, type BookLineInput, type BookSpecInput } from './books.js'
import { type DB } from './db.js'
import { assertOrderItemRow, assertOrderRow } from './db-guards.js'
import { finishingContribution, type FinishingPricing } from './finishing.js'
import { getLog } from './logger.js'
import { getEffectiveTier, membershipDiscountAmount } from './membership.js'
import { lineTotal, money, moneyC, sumMoney } from './money.js'
import { quote } from './pricing.js'

/** 带 statusCode 抛出，由 app 全局 errorHandler 映射为 { error: message }（<500 不落日志） */
export class OrderError extends Error {
  public statusCode: number
  constructor(status: number, message: string) {
    super(message)
    this.statusCode = status
  }
}

export type OrderStatus =
  | 'quoted'
  | 'file_pending'
  | 'file_approved'
  | 'confirmed'
  | 'in_production'
  | 'printed'
  | 'ready'
  | 'delivered'
  | 'cancelled'

/** 手动流转（admin）。file_pending/file_approved 仅系统自动流转（上传齐 / 审稿全过），不可手动指定 */
const ADMIN_NEXT: Record<string, readonly string[]> = {
  quoted: ['cancelled'],
  file_pending: ['cancelled'],
  file_approved: ['confirmed', 'cancelled'],
  confirmed: ['in_production', 'cancelled'],
  in_production: ['printed', 'cancelled'],
  printed: ['ready', 'cancelled'],
  ready: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
}

/** customer/member 仅可取消自己的单，且只在 confirm 之前（confirmed 起仅 admin） */
export const CUSTOMER_CANCELLABLE: readonly string[] = ['quoted', 'file_pending', 'file_approved']

export function adminCanTransition(from: string, to: string): boolean {
  return (ADMIN_NEXT[from] ?? []).includes(to)
}

export interface OrderRow {
  id: string
  order_number: string
  access_token: string
  customer_id: string
  contact_info: string | null
  is_internal: number
  subtotal: number
  discount: number
  total: number
  payment_status: string
  paid_amount: number
  payment_method: string | null
  paid_at: string | null
  status: OrderStatus
  quote_valid_until: string
  created_at: string
  confirmed_at: string | null
  due_date: string | null
  completed_at: string | null
  notes: string | null
  guest_email: string | null
  guest_name: string | null
  guest_contact: string | null
  delivery_method: string
  delivery_address: string | null
  membership_discount: number
  membership_tier_id: number | null
}

/** D23: 已验证用户认领访客单（仅 guest_email 与本人邮箱一致时），改绑 customer_id 并清访客字段 */
export function claimGuestOrder(db: DB, orderId: string, userId: string): void {
  db.prepare(
    'UPDATE orders SET customer_id = ?, guest_email = NULL, guest_name = NULL, guest_contact = NULL WHERE id = ?',
  ).run(userId, orderId)
}

export interface OrderItemRow {
  id: string
  order_id: string
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  unit_price_c: number
  line_total: number
  file_url: string | null
  file_status: 'pending' | 'approved' | 'rejected'
  file_note: string | null
  file_precheck: string | null
  job_id: string | null
  mode_name: string
  paper_name: string
  size_label: string
  color_class: string
  tech: string
  duplex: number
}

export function getOrder(db: DB, id: string): OrderRow | undefined {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined
  if (row) assertOrderRow(row as unknown as Record<string, unknown>)
  return row
}

export function getOrderItems(db: DB, orderId: string): OrderItemRow[] {
  const rows = db
    .prepare(
      `SELECT oi.*, m.name AS mode_name, p.name AS paper_name, s.label AS size_label,
              COALESCE(m.color_class, 'color') AS color_class, pr.type AS tech, m.duplex
       FROM order_items oi
       JOIN print_modes m ON m.id = oi.mode_id
       JOIN printers pr ON pr.id = m.printer_id
       JOIN papers p ON p.id = oi.paper_id
       JOIN sizes s ON s.key = oi.size_key
       WHERE oi.order_id = ?
       ORDER BY oi.rowid`,
    )
    .all(orderId) as OrderItemRow[]
  for (const r of rows) assertOrderItemRow(r as unknown as Record<string, unknown>)
  return rows
}

// ---------- D27 书行读取 ----------

export interface OrderBookRow {
  id: string
  order_id: string
  book_id: number
  name: string
  count: number
  unit_price_c: number
  line_total: number
}

export interface OrderBookComponentRow {
  id: string
  order_book_id: string
  role: string
  paper_id: number
  size_key: string
  color_class: string
  duplex: number
  mode_id: number
  sheets_per_book: number
  unit_sell_c: number
  job_id: string | null
  source_component_id: number | null
  file_url: string | null
  file_status: 'pending' | 'approved' | 'rejected'
  file_note: string | null
  file_precheck: string | null
  paper_name: string
  size_label: string
}

export interface OrderBookFinishingRow {
  id: string
  order_book_id: string
  finishing_id: number
  name: string
  pricing: string
  price_c: number
  contribution_c: number
}

export interface OrderBook {
  book: OrderBookRow
  components: OrderBookComponentRow[]
  finishings: OrderBookFinishingRow[]
}

/** 一单全部书行（含组件 + 工艺快照）。组件带 paper/size 展示名（机器 mode_id 仅 admin DTO 暴露） */
export function getOrderBooks(db: DB, orderId: string): OrderBook[] {
  const books = db
    .prepare('SELECT * FROM order_books WHERE order_id = ? ORDER BY rowid')
    .all(orderId) as OrderBookRow[]
  if (books.length === 0) return []
  const ids = books.map((b) => b.id)
  const ph = ids.map(() => '?').join(',')
  const comps = db.prepare(
    `SELECT obc.*, p.name AS paper_name, s.label AS size_label
     FROM order_book_components obc
     JOIN papers p ON p.id = obc.paper_id
     JOIN sizes s ON s.key = obc.size_key
     WHERE obc.order_book_id IN (${ph})
     ORDER BY obc.rowid`,
  ).all(...ids) as OrderBookComponentRow[]
  const fins = db.prepare(
    `SELECT * FROM order_book_finishings WHERE order_book_id IN (${ph}) ORDER BY rowid`,
  ).all(...ids) as OrderBookFinishingRow[]
  const compMap = new Map<string, OrderBookComponentRow[]>()
  for (const c of comps) {
    const arr = compMap.get(c.order_book_id)
    if (arr) arr.push(c)
    else compMap.set(c.order_book_id, [c])
  }
  const finMap = new Map<string, OrderBookFinishingRow[]>()
  for (const f of fins) {
    const arr = finMap.get(f.order_book_id)
    if (arr) arr.push(f)
    else finMap.set(f.order_book_id, [f])
  }
  return books.map((book) => ({
    book,
    components: compMap.get(book.id) ?? [],
    finishings: finMap.get(book.id) ?? [],
  }))
}

// ---------- 单张 item 工艺快照读取 ----------

export interface OrderItemFinishingRow {
  id: string
  order_item_id: string
  finishing_id: number
  name: string
  pricing: string
  price_c: number
  contribution_c: number
}

export function getOrderItemFinishings(db: DB, orderId: string): OrderItemFinishingRow[] {
  return db
    .prepare(
      `SELECT oif.*
       FROM order_item_finishings oif
       JOIN order_items oi ON oi.id = oif.order_item_id
       WHERE oi.order_id = ?
       ORDER BY oif.rowid`,
    )
    .all(orderId) as OrderItemFinishingRow[]
}

/** FOL-YYYY-NNNN：仅人类可读展示，不可用作查询键（查询走 access_token） */
function nextOrderNumber(db: DB, now: Date): string {
  const year = now.getUTCFullYear()
  const prefix = `FOL-${year}-`
  const row = db
    .prepare('SELECT order_number FROM orders WHERE order_number LIKE ? ORDER BY order_number DESC LIMIT 1')
    .get(`${prefix}%`) as { order_number: string } | undefined
  const seq = row ? Number(row.order_number.slice(prefix.length)) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

export interface NewOrderItem {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  finishing_ids?: number[]
}

/** 访客单的合成 customer_id（0007 哨兵用户，archived=1 永不登录） */
export const GUEST_SENTINEL_ID = 'guest'

export interface CreateOrderInput {
  customerId: string
  /** member/admin 视为内部需求：internal_sell_c 口径 + is_internal 标记（B1.1） */
  internal: boolean
  items: NewOrderItem[]
  /** D27 书行：一本书 = 购物车一行（成品 + 每组件每本张数 + 本数） */
  books?: BookLineInput[]
  /** D36 自定义书册行：客户直接指定组件规格（不引用成品） */
  customBooks?: BookSpecInput[]
  contactInfo?: string | null
  notes?: string | null
  /** D30 配送：'pickup'（默认）| 'shipping'（须 deliveryAddress 非空） */
  deliveryMethod?: 'pickup' | 'shipping'
  deliveryAddress?: string | null
  /** 访客单留痕（D23）：customerId 取哨兵，guest_* 落联系方式 */
  guestEmail?: string | null
  guestName?: string | null
  guestContact?: string | null
}

/** R1/R3 + D27: 下单——unit_price_c 当场定格快照（单页 item 与书行同口径），line_total 唯一舍入点，subtotal 整数加法 */
export function createOrder(db: DB, input: CreateOrderInput): string {
  const cfg = db
    .prepare('SELECT quote_valid_days, pricing_needs_reentry FROM system_config WHERE id = 1')
    .get() as { quote_valid_days: number; pricing_needs_reentry: number } | undefined
  if (!cfg) throw new Error('orders: system_config missing (run spool init)')
  // M8 切币防护栏：定价待按新币种重录期间拒绝下单，避免静默按旧量级计价（见 migration 0034 / 0019）
  if (cfg.pricing_needs_reentry !== 0) throw new OrderError(409, 'pricing_reentry_required')

  const getModeForFin = db.prepare('SELECT duplex FROM print_modes WHERE id = ?')
  const getSizeForFin = db.prepare('SELECT area FROM sizes WHERE key = ?')

  const priced = input.items.map((item, idx) => {
    const q = quote(db, item.mode_id, item.paper_id, item.size_key, {
      internal: input.internal,
      quantity: item.quantity,
    })
    if (!q) throw new OrderError(422, `item_${idx}_not_quotable`)

    let unitC = q.sell_c as number
    const itemFins: Array<{ finishing_id: number; name: string; pricing: FinishingPricing; price_c: number; contribution_c: number }> = []

    if (item.finishing_ids && item.finishing_ids.length > 0) {
      const mode = getModeForFin.get(item.mode_id) as { duplex: number } | undefined
      const size = getSizeForFin.get(item.size_key) as { area: number } | undefined
      if (mode && size) {
        const ctx = { pages: mode.duplex ? 2 : 1, area: size.area }
        const fins = db
          .prepare(
            `SELECT id, name, pricing, price_c FROM finishing_ops
             WHERE id IN (${item.finishing_ids.map(() => '?').join(',')}) AND archived = 0`,
          )
          .all(...item.finishing_ids) as Array<{ id: number; name: string; pricing: FinishingPricing; price_c: number }>
        for (const f of fins) {
          const c = finishingContribution(f, ctx) as number
          unitC += c
          itemFins.push({ finishing_id: f.id, name: f.name, pricing: f.pricing, price_c: f.price_c, contribution_c: c })
        }
      }
    }
    if (!Number.isSafeInteger(unitC)) throw new OrderError(422, `item_${idx}_price_overflow`)
    const sellC = moneyC(unitC)
    return { ...item, unit_price_c: sellC, line_total: lineTotal(sellC, item.quantity), finishings: itemFins }
  })

  // D27 书行：priceBook 定格每本 unit_price_c（含组件 + 工艺），line_total 同唯一舍入点。
  // 不可报价/缺张数 → BookError(422) 上抛，与 item 同由全局 errorHandler 映射。
  const books = (input.books ?? []).map((bl) => {
    const bq = priceBook(db, bl, { internal: input.internal })
    return { input: bl, quote: bq, line_total: lineTotal(bq.unit_price_c, bl.count) }
  })

  // D36 自定义书册：客户直接指定组件规格
  const customBooks = (input.customBooks ?? []).map((spec) => {
    const bq = priceBookSpec(db, spec, { internal: input.internal })
    return { input: spec, quote: bq, line_total: lineTotal(bq.unit_price_c, spec.count) }
  })

  if (priced.length === 0 && books.length === 0 && customBooks.length === 0) throw new OrderError(422, 'empty_order')

  // D30 配送：邮寄须有非空地址
  const deliveryMethod = input.deliveryMethod ?? 'pickup'
  const deliveryAddress = input.deliveryAddress?.trim() ? input.deliveryAddress.trim() : null
  if (deliveryMethod === 'shipping' && !deliveryAddress) {
    throw new OrderError(422, 'delivery_address_required')
  }

  const subtotal = sumMoney([...priced.map((p) => p.line_total), ...books.map((b) => b.line_total), ...customBooks.map((b) => b.line_total)])

  const effectiveTier = getEffectiveTier(db, input.customerId)
  const discountBp = effectiveTier?.discount_bp ?? 0
  const mbrDiscount = membershipDiscountAmount(subtotal, discountBp)
  const total = money((subtotal as number) - (mbrDiscount as number))

  const now = new Date()
  const nowIso = now.toISOString()
  const validUntil = new Date(now.getTime() + cfg.quote_valid_days * 86_400_000).toISOString()
  const orderId = randomUUID()

  db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, order_number, access_token, customer_id, contact_info, is_internal,
                           subtotal, discount, total, membership_discount, membership_tier_id,
                           status, quote_valid_until, created_at, notes,
                           guest_email, guest_name, guest_contact, delivery_method, delivery_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      orderId,
      nextOrderNumber(db, now),
      randomBytes(24).toString('base64url'),
      input.customerId,
      input.contactInfo ?? null,
      input.internal ? 1 : 0,
      subtotal,
      total,
      mbrDiscount,
      effectiveTier?.tier_id ?? null,
      validUntil,
      nowIso,
      input.notes ?? null,
      input.guestEmail ?? null,
      input.guestName ?? null,
      input.guestContact ?? null,
      deliveryMethod,
      deliveryAddress,
    )
    const insertItem = db.prepare(
      `INSERT INTO order_items (id, order_id, mode_id, paper_id, size_key, quantity,
                                unit_price_c, line_total, file_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    const insertItemFin = db.prepare(
      `INSERT INTO order_item_finishings (id, order_item_id, finishing_id, name, pricing, price_c, contribution_c)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const p of priced) {
      const itemId = randomUUID()
      insertItem.run(itemId, orderId, p.mode_id, p.paper_id, p.size_key, p.quantity, p.unit_price_c, p.line_total)
      for (const f of p.finishings) {
        insertItemFin.run(randomUUID(), itemId, f.finishing_id, f.name, f.pricing, f.price_c, f.contribution_c)
      }
    }

    const insertBook = db.prepare(
      `INSERT INTO order_books (id, order_id, book_id, name, count, unit_price_c, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertBookComp = db.prepare(
      `INSERT INTO order_book_components (id, order_book_id, role, paper_id, size_key, color_class,
                                          duplex, mode_id, sheets_per_book, unit_sell_c, source_component_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertBookFin = db.prepare(
      `INSERT INTO order_book_finishings (id, order_book_id, finishing_id, name, pricing, price_c, contribution_c)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const b of books) {
      const obId = randomUUID()
      insertBook.run(obId, orderId, b.quote.book_id, b.quote.name, b.input.count, b.quote.unit_price_c, b.line_total)
      for (const c of b.quote.components) {
        insertBookComp.run(
          randomUUID(),
          obId,
          c.role,
          c.paper_id,
          c.size_key,
          c.color_class,
          c.duplex,
          c.mode_id,
          c.sheets_per_book,
          c.unit_sell_c,
          c.component_id,
        )
      }
      for (const f of b.quote.finishings) {
        insertBookFin.run(randomUUID(), obId, f.finishing_id, f.name, f.pricing, f.price_c, f.contribution_c)
      }
    }

    // D36 自定义书册：book_id = NULL
    for (const cb of customBooks) {
      const obId = randomUUID()
      insertBook.run(obId, orderId, null, cb.quote.name, cb.input.count, cb.quote.unit_price_c, cb.line_total)
      for (const c of cb.quote.components) {
        insertBookComp.run(
          randomUUID(), obId, c.role, c.paper_id, c.size_key, c.color_class,
          c.duplex, c.mode_id, c.sheets_per_book, c.unit_sell_c, null,
        )
      }
      for (const f of cb.quote.finishings) {
        insertBookFin.run(randomUUID(), obId, f.finishing_id, f.name, f.pricing, f.price_c, f.contribution_c)
      }
    }
  })()
  return orderId
}

/**
 * 审稿环节自动流转（R1 定点 + D31）：单页 item 与书组件同入一个文件池——
 *   quoted        → 全部可上传行（item + 书组件）有文件 → file_pending
 *   file_pending  ⇄ file_approved：全部 approved → file_approved；任一非 approved → file_pending
 * 返回流转后状态与是否变化（通知钩子用）
 */
export function syncFileState(db: DB, orderId: string): { status: OrderStatus; changed: boolean } {
  const order = getOrder(db, orderId)
  if (!order) throw new OrderError(404, 'not_found')
  if (!['quoted', 'file_pending', 'file_approved'].includes(order.status)) {
    return { status: order.status, changed: false }
  }
  const itemCounts = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN file_url IS NOT NULL THEN 1 ELSE 0 END) AS filed,
              SUM(CASE WHEN file_status = 'approved' THEN 1 ELSE 0 END) AS approved
       FROM order_items WHERE order_id = ?`,
    )
    .get(orderId) as { n: number; filed: number | null; approved: number | null }
  const compCounts = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN obc.file_url IS NOT NULL THEN 1 ELSE 0 END) AS filed,
              SUM(CASE WHEN obc.file_status = 'approved' THEN 1 ELSE 0 END) AS approved
       FROM order_book_components obc
       JOIN order_books ob ON ob.id = obc.order_book_id
       WHERE ob.order_id = ?`,
    )
    .get(orderId) as { n: number; filed: number | null; approved: number | null }
  const n = itemCounts.n + compCounts.n
  const filed = (itemCounts.filed ?? 0) + (compCounts.filed ?? 0)
  const approved = (itemCounts.approved ?? 0) + (compCounts.approved ?? 0)

  let next: OrderStatus = order.status
  if (n > 0 && filed === n) {
    next = approved === n ? 'file_approved' : 'file_pending'
  } else if (order.status !== 'quoted') {
    next = order.status
  }
  if (next === order.status) return { status: next, changed: false }
  getLog().info({ orderId, from: order.status, to: next, items: n, filed, approved }, 'syncFileState transition')
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(next, orderId)
  return { status: next, changed: true }
}

/**
 * 整数定点折扣分摊（largest-remainder / Hamilton 法）：share_i ∈ {floor, ceil}(discount×line_i/subtotal)，
 * 余额按分数余数从大到小 +1。因 discount ≤ subtotal ⇒ 精确份额 ≤ line_i ⇒ ceil 亦 ≤ line_i（line 为整数），
 * 故每份 ∈ [0, line_total]，line_total − share ≥ 0（杜绝负 quoted_price）；Σshare === discount 守恒。
 * 旧实现把全部下取整余额堆到末行，小末行会被打穿成负 quoted_price（已修）。导出供性质测试。
 */
export function distributeDiscount(discount: number, subtotal: number, lineTotals: readonly number[]): number[] {
  const n = lineTotals.length
  if (discount <= 0 || subtotal <= 0 || n === 0) return lineTotals.map(() => 0)
  const base: number[] = []
  const rem: number[] = []
  let allocated = 0
  for (let i = 0; i < n; i++) {
    const num = discount * lineTotals[i]!
    const r = num % subtotal
    const b = (num - r) / subtotal
    base.push(b)
    rem.push(r)
    allocated += b
  }
  const leftover = discount - allocated // ∈ [0, n)
  const order = base.map((_, i) => i).sort((a, b) => rem[b]! - rem[a]! || a - b)
  for (let k = 0; k < leftover; k++) base[order[k]!]! += 1
  return base
}

/**
 * 整数权重分摊：split_i = floor(total × w_i ÷ Σw)，末位吸收余额（Σ = total）。
 * 全零权重（罕见）→ 全归末位。D27 书行营收按组件材料贡献分入各组件作业 quoted_price。
 */
function splitByWeight(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return []
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map((_, i) => (i === weights.length - 1 ? total : 0))
  const shares: number[] = []
  let allocated = 0
  for (let i = 0; i < weights.length; i++) {
    if (i === weights.length - 1) {
      shares.push(total - allocated)
    } else {
      const num = total * weights[i]!
      const rem = num % sum
      const share = (num - rem) / sum
      shares.push(share)
      allocated += share
    }
  }
  return shares
}

const ROLE_LABEL: Record<string, string> = { cover: '封面', inner: '内页', insert: '插图' }

/**
 * R1/R6 + D27/D31 confirm：未过 quote_valid_until（过期 409，须重新报价）。
 * 凡有可上传行（单页 item 或书组件）即须 file_approved（审稿过）——书单与单页 item 同口径，
 * 不再有「纯书单从 quoted 直接确认」的无文件门特例。退化单（无任何可上传行）才允许 quoted 起确认。
 * 单事务：逐 item 生成 Job(queued) 回写 order_items.job_id；逐书行按组件拆 Job(queued) 回写
 * order_book_components.job_id（工艺已落 order_book_finishings 作记录）。
 * 折扣按全部行（item + 书行）比例整数分摊；书行营收再按组件材料贡献整数分摊进各组件 quoted_price，
 * Σ(全部 job quoted_price) === total 守恒。
 */
export function confirmOrder(db: DB, orderId: string): void {
  const order = getOrder(db, orderId)
  if (!order) throw new OrderError(404, 'not_found')
  const items = getOrderItems(db, orderId)
  const books = getOrderBooks(db, orderId)
  // 可上传行数 = 单页 item + 全部书组件；>0 须 file_approved（审稿过）
  const fileableLines = items.length + books.reduce((s, b) => s + b.components.length, 0)
  const confirmable =
    fileableLines > 0 ? ['file_approved'] : ['quoted', 'file_pending', 'file_approved']
  if (!confirmable.includes(order.status)) {
    throw new OrderError(409, `not_confirmable_from_${order.status}`)
  }
  const nowIso = new Date().toISOString()
  if (nowIso > order.quote_valid_until) throw new OrderError(409, 'quote_expired')

  const lineTotals = [...items.map((it) => it.line_total), ...books.map((b) => b.book.line_total)]
  const totalDiscount = order.discount + order.membership_discount
  const shares = distributeDiscount(totalDiscount, order.subtotal, lineTotals)
  const itemShares = shares.slice(0, items.length)
  const bookShares = shares.slice(items.length)
  if (totalDiscount > 0) {
    getLog().info({ orderId, discount: order.discount, membershipDiscount: order.membership_discount, subtotal: order.subtotal, lines: lineTotals.length }, 'confirm: discount distributed')
  }

  db.transaction(() => {
    const insertJob = db.prepare(
      `INSERT INTO jobs (id, order_item_id, requester_id, title, mode_id, paper_id, size_key,
                         quantity, quoted_price, file_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    const backfillItem = db.prepare('UPDATE order_items SET job_id = ? WHERE id = ?')
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      const jobId = randomUUID()
      insertJob.run(
        jobId,
        item.id,
        order.customer_id,
        `${order.order_number} · ${item.mode_name} × ${item.paper_name} ${item.size_key}`,
        item.mode_id,
        item.paper_id,
        item.size_key,
        item.quantity,
        item.line_total - itemShares[i]!,
        item.file_url,
        nowIso,
      )
      backfillItem.run(jobId, item.id)
    }

    const backfillComp = db.prepare('UPDATE order_book_components SET job_id = ? WHERE id = ?')
    for (let bi = 0; bi < books.length; bi++) {
      const b = books[bi]!
      const bookRevenue = b.book.line_total - bookShares[bi]!
      // 组件营收权重 = 单页价 × 每本张数 × 本数（材料贡献）
      const weights = b.components.map((c) => c.unit_sell_c * c.sheets_per_book * b.book.count)
      const compShares = splitByWeight(bookRevenue, weights)
      for (let ci = 0; ci < b.components.length; ci++) {
        const c = b.components[ci]!
        const jobId = randomUUID()
        // 组件作业：order_item_id NULL（书行作业），mode_id 取下单定格的最便宜机器（admin 可改派）
        insertJob.run(
          jobId,
          null,
          order.customer_id,
          `${order.order_number} · ${b.book.name} · ${ROLE_LABEL[c.role] ?? c.role} ${c.size_key}`,
          c.mode_id,
          c.paper_id,
          c.size_key,
          c.sheets_per_book * b.book.count,
          compShares[ci]!,
          null,
          nowIso,
        )
        backfillComp.run(jobId, c.id)
      }
    }
    db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(nowIso, orderId)
  })()
}

/** 作业完成后检查：该订单全部作业已 done/cancelled（至少一个 done）→ 自动 in_production → printed */
export function tryAdvanceToPrinted(db: DB, jobId: string): string | null {
  const orderId = (
    db
      .prepare(
        `SELECT oi.order_id FROM order_items oi JOIN jobs j ON j.order_item_id = oi.id WHERE j.id = ?
         UNION
         SELECT ob.order_id FROM order_books ob
         JOIN order_book_components obc ON obc.order_book_id = ob.id
         WHERE obc.job_id = ?`,
      )
      .get(jobId, jobId) as { order_id: string } | undefined
  )?.order_id
  if (!orderId) return null

  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as { status: string } | undefined
  if (!order || order.status !== 'in_production') return null

  const counts = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('done','cancelled')) AS pending,
         COUNT(*) FILTER (WHERE status = 'done') AS done
       FROM jobs
       WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)
          OR id IN (
            SELECT obc.job_id FROM order_book_components obc
            JOIN order_books ob ON ob.id = obc.order_book_id
            WHERE ob.order_id = ? AND obc.job_id IS NOT NULL
          )`,
    )
    .get(orderId, orderId) as { pending: number; done: number }

  if (counts.pending === 0 && counts.done > 0) {
    db.prepare("UPDATE orders SET status = 'printed' WHERE id = ?").run(orderId)
    return orderId
  }
  return null
}

/** 取消（admin 任意非终态；customer 限 CUSTOMER_CANCELLABLE）。已确认订单连带取消未完成作业（D14） */
export function cancelOrder(db: DB, orderId: string): void {
  const order = getOrder(db, orderId)
  if (!order) throw new OrderError(404, 'not_found')
  if (!adminCanTransition(order.status, 'cancelled')) {
    throw new OrderError(409, `invalid_transition_${order.status}_to_cancelled`)
  }
  const nowIso = new Date().toISOString()
  db.transaction(() => {
    // C3: queued/printing 从未动过库存，取消零回滚；done 作业（已产出）不动
    db.prepare(
      `UPDATE jobs SET status = 'cancelled', completed_at = ?
       WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)
         AND status IN ('draft', 'queued', 'printing')`,
    ).run(nowIso, orderId)
    // D27: 书行组件作业（order_item_id NULL，经 order_book_components.job_id 关联）连带取消
    db.prepare(
      `UPDATE jobs SET status = 'cancelled', completed_at = ?
       WHERE id IN (
               SELECT job_id FROM order_book_components
               WHERE job_id IS NOT NULL
                 AND order_book_id IN (SELECT id FROM order_books WHERE order_id = ?))
         AND status IN ('draft', 'queued', 'printing')`,
    ).run(nowIso, orderId)
    db.prepare("UPDATE orders SET status = 'cancelled', completed_at = ? WHERE id = ?").run(nowIso, orderId)
  })()
}
