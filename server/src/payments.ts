import { randomUUID } from 'node:crypto'
import { type DB } from './db.js'
import { assertPaymentRow } from './db-guards.js'
import { getLog } from './logger.js'
import { getOrder } from './orders.js'

/** 带 statusCode 抛出，由 app 全局 errorHandler 映射 */
export class PaymentError extends Error {
  public statusCode: number
  constructor(status: number, message: string) {
    super(message)
    this.statusCode = status
  }
}

export type PaymentKind = 'deposit' | 'balance' | 'refund'

export interface PaymentRow {
  id: string
  order_id: string
  kind: PaymentKind
  amount: number
  method: string | null
  operator_id: string | null
  note: string | null
  created_at: string
}

export type PaymentStatus = 'unpaid' | 'deposit' | 'paid'

/** D28 投影：paid≤0→unpaid · paid≥total→paid · 其间→deposit */
export function projectStatus(paid: number, total: number): PaymentStatus {
  if (paid <= 0) return 'unpaid'
  if (paid >= total) return 'paid'
  return 'deposit'
}

export function getPayments(db: DB, orderId: string): PaymentRow[] {
  const rows = db
    .prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at, rowid')
    .all(orderId) as PaymentRow[]
  for (const r of rows) assertPaymentRow(r as unknown as Record<string, unknown>)
  return rows
}

export interface RecordPaymentInput {
  kind: PaymentKind
  /** 金额层带符号：deposit/balance 须 > 0，refund 须 < 0 */
  amount: number
  method?: string | null
  operatorId?: string | null
  note?: string | null
}

/** orders.paid_amount/payment_status/paid_at/payment_method 重算为 payments 投影 */
function reproject(db: DB, orderId: string, total: number): void {
  const paid = (
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE order_id = ?').get(orderId) as { s: number }
  ).s
  const status = projectStatus(paid, total)
  const paidAt =
    paid > 0
      ? (db.prepare('SELECT MIN(created_at) AS t FROM payments WHERE order_id = ?').get(orderId) as { t: string | null }).t
      : null
  const method =
    (db
      .prepare('SELECT method FROM payments WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(orderId) as { method: string | null } | undefined)?.method ?? null
  db.prepare(
    'UPDATE orders SET paid_amount = ?, payment_status = ?, paid_at = ?, payment_method = ? WHERE id = ?',
  ).run(paid, status, paidAt, method, orderId)
}

/**
 * D28 追加一笔流水并重算投影（单事务）。强制 0 ≤ Σamount ≤ total 且 kind↔符号一致。
 * 收款超过应付 → 422 paid_exceeds_total；退款超过已收 → 422 refund_exceeds_paid。
 */
export function recordPayment(db: DB, orderId: string, input: RecordPaymentInput): PaymentRow {
  const order = getOrder(db, orderId)
  if (!order) throw new PaymentError(404, 'not_found')

  if (input.kind === 'refund') {
    if (!(input.amount < 0)) throw new PaymentError(422, 'refund_must_be_negative')
  } else if (!(input.amount > 0)) {
    throw new PaymentError(422, 'charge_must_be_positive')
  }

  const current = (
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE order_id = ?').get(orderId) as { s: number }
  ).s
  const next = current + input.amount
  if (next < 0) throw new PaymentError(422, 'refund_exceeds_paid')
  if (next > order.total) throw new PaymentError(422, 'paid_exceeds_total')

  const id = randomUUID()
  const now = new Date().toISOString()
  const oldStatus = order.payment_status as string
  const oldPaid = order.paid_amount as number
  db.transaction(() => {
    db.prepare(
      `INSERT INTO payments (id, order_id, kind, amount, method, operator_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orderId, input.kind, input.amount, input.method ?? null, input.operatorId ?? null, input.note ?? null, now)
    reproject(db, orderId, order.total)
  })()
  const updated = getOrder(db, orderId)!
  getLog().info(
    { orderId, kind: input.kind, amount: input.amount, paid: `${oldPaid}→${updated.paid_amount}`, status: `${oldStatus}→${updated.payment_status}` },
    'payment recorded',
  )
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as PaymentRow
  assertPaymentRow(row as unknown as Record<string, unknown>)
  return row
}
