import { randomBytes, randomUUID } from 'node:crypto'
import { type DB } from './db.js'
import { lineTotal, sumMoney } from './money.js'
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
  | 'ready'
  | 'delivered'
  | 'cancelled'

/** 手动流转（admin）。file_pending/file_approved 仅系统自动流转（上传齐 / 审稿全过），不可手动指定 */
const ADMIN_NEXT: Record<string, readonly string[]> = {
  quoted: ['cancelled'],
  file_pending: ['cancelled'],
  file_approved: ['confirmed', 'cancelled'],
  confirmed: ['in_production', 'cancelled'],
  in_production: ['ready', 'cancelled'],
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
  job_id: string | null
  mode_name: string
  paper_name: string
  size_label: string
}

export function getOrder(db: DB, id: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined
}

export function getOrderItems(db: DB, orderId: string): OrderItemRow[] {
  return db
    .prepare(
      `SELECT oi.*, m.name AS mode_name, p.name AS paper_name, s.label AS size_label
       FROM order_items oi
       JOIN print_modes m ON m.id = oi.mode_id
       JOIN papers p ON p.id = oi.paper_id
       JOIN sizes s ON s.key = oi.size_key
       WHERE oi.order_id = ?
       ORDER BY oi.rowid`,
    )
    .all(orderId) as OrderItemRow[]
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
}

/** 访客单的合成 customer_id（0007 哨兵用户，archived=1 永不登录） */
export const GUEST_SENTINEL_ID = 'guest'

export interface CreateOrderInput {
  customerId: string
  /** member/admin 视为内部需求：internal_sell_c 口径 + is_internal 标记（B1.1） */
  internal: boolean
  items: NewOrderItem[]
  contactInfo?: string | null
  notes?: string | null
  /** 访客单留痕（D23）：customerId 取哨兵，guest_* 落联系方式 */
  guestEmail?: string | null
  guestName?: string | null
  guestContact?: string | null
}

/** R1/R3: 下单——unit_price_c 当场定格快照，line_total 唯一舍入点，subtotal 整数加法 */
export function createOrder(db: DB, input: CreateOrderInput): string {
  const cfg = db.prepare('SELECT quote_valid_days FROM system_config WHERE id = 1').get() as
    | { quote_valid_days: number }
    | undefined
  if (!cfg) throw new Error('orders: system_config missing (run spool init)')

  const priced = input.items.map((item, idx) => {
    const q = quote(db, item.mode_id, item.paper_id, item.size_key, { internal: input.internal })
    if (!q) throw new OrderError(422, `item_${idx}_not_quotable`)
    return { ...item, unit_price_c: q.sell_c, line_total: lineTotal(q.sell_c, item.quantity) }
  })
  const subtotal = sumMoney(priced.map((p) => p.line_total))

  const now = new Date()
  const nowIso = now.toISOString()
  const validUntil = new Date(now.getTime() + cfg.quote_valid_days * 86_400_000).toISOString()
  const orderId = randomUUID()

  db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, order_number, access_token, customer_id, contact_info, is_internal,
                           subtotal, discount, total, status, quote_valid_until, created_at, notes,
                           guest_email, guest_name, guest_contact)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'quoted', ?, ?, ?, ?, ?, ?)`,
    ).run(
      orderId,
      nextOrderNumber(db, now),
      randomBytes(24).toString('base64url'),
      input.customerId,
      input.contactInfo ?? null,
      input.internal ? 1 : 0,
      subtotal,
      subtotal,
      validUntil,
      nowIso,
      input.notes ?? null,
      input.guestEmail ?? null,
      input.guestName ?? null,
      input.guestContact ?? null,
    )
    const insertItem = db.prepare(
      `INSERT INTO order_items (id, order_id, mode_id, paper_id, size_key, quantity,
                                unit_price_c, line_total, file_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    for (const p of priced) {
      insertItem.run(randomUUID(), orderId, p.mode_id, p.paper_id, p.size_key, p.quantity, p.unit_price_c, p.line_total)
    }
  })()
  return orderId
}

/**
 * 审稿环节自动流转（R1 定点）：
 *   quoted        → 全部 item 有文件 → file_pending
 *   file_pending  ⇄ file_approved：全部 approved → file_approved；任一非 approved → file_pending
 * 返回流转后状态与是否变化（通知钩子用）
 */
export function syncFileState(db: DB, orderId: string): { status: OrderStatus; changed: boolean } {
  const order = getOrder(db, orderId)
  if (!order) throw new OrderError(404, 'not_found')
  if (!['quoted', 'file_pending', 'file_approved'].includes(order.status)) {
    return { status: order.status, changed: false }
  }
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN file_url IS NOT NULL THEN 1 ELSE 0 END) AS filed,
              SUM(CASE WHEN file_status = 'approved' THEN 1 ELSE 0 END) AS approved
       FROM order_items WHERE order_id = ?`,
    )
    .get(orderId) as { n: number; filed: number; approved: number }

  let next: OrderStatus = order.status
  if (counts.n > 0 && counts.filed === counts.n) {
    next = counts.approved === counts.n ? 'file_approved' : 'file_pending'
  } else if (order.status !== 'quoted') {
    // 不应发生（上传后文件不删除），防御性维持现状
    next = order.status
  }
  if (next === order.status) return { status: next, changed: false }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(next, orderId)
  return { status: next, changed: true }
}

/** Integer-only pro-rata: share_i = floor(discount × line_total_i ÷ subtotal), remainder to last. */
function distributeDiscount(discount: number, subtotal: number, lineTotals: readonly number[]): number[] {
  if (discount <= 0 || subtotal <= 0 || lineTotals.length === 0) {
    return lineTotals.map(() => 0)
  }
  const shares: number[] = []
  let allocated = 0
  for (let i = 0; i < lineTotals.length; i++) {
    if (i === lineTotals.length - 1) {
      shares.push(discount - allocated)
    } else {
      const num = discount * lineTotals[i]!
      const rem = num % subtotal
      const share = (num - rem) / subtotal
      shares.push(share)
      allocated += share
    }
  }
  return shares
}

/**
 * R1/R6 confirm：仅 file_approved 且未过 quote_valid_until（过期 409，须重新报价）。
 * 单事务：逐 item 生成 Job(queued) 并回写 order_items.job_id。
 * 折扣按行比例整数分摊进 quoted_price，Σ(quoted_price) === total 守恒。
 */
export function confirmOrder(db: DB, orderId: string): void {
  const order = getOrder(db, orderId)
  if (!order) throw new OrderError(404, 'not_found')
  if (order.status !== 'file_approved') {
    throw new OrderError(409, `not_confirmable_from_${order.status}`)
  }
  const nowIso = new Date().toISOString()
  if (nowIso > order.quote_valid_until) throw new OrderError(409, 'quote_expired')

  const items = getOrderItems(db, orderId)
  const shares = distributeDiscount(order.discount, order.subtotal, items.map((it) => it.line_total))
  db.transaction(() => {
    const insertJob = db.prepare(
      `INSERT INTO jobs (id, order_item_id, requester_id, title, mode_id, paper_id, size_key,
                         quantity, quoted_price, file_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    const backfill = db.prepare('UPDATE order_items SET job_id = ? WHERE id = ?')
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
        item.line_total - shares[i]!,
        item.file_url,
        nowIso,
      )
      backfill.run(jobId, item.id)
    }
    db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(nowIso, orderId)
  })()
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
    db.prepare("UPDATE orders SET status = 'cancelled', completed_at = ? WHERE id = ?").run(nowIso, orderId)
  })()
}
