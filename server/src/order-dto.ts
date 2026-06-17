import { type DB } from './db.js'
import { formatMoney, formatMoneyC, money, moneyC, type Currency } from './money.js'
import {
  getOrderBooks,
  getOrderItems,
  getOrderItemFinishings,
  GUEST_SENTINEL_ID,
  type OrderBook,
  type OrderItemFinishingRow,
  type OrderItemRow,
  type OrderRow,
} from './orders.js'
import { getPayments, type PaymentRow } from './payments.js'

// ---------- 序列化白名单（D5/§6）：下单域响应仅含售价侧字段，cost/profit/margin 不进 schema ----------

// D35 文件预检（advisory；两域售价侧——无 cost/profit/margin 字段，owner 自查用）
export const PRECHECK_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    level: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          level: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
}

const ORDER_ITEM_FINISHING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    finishing_id: { type: 'integer' },
    name: { type: 'string' },
    pricing: { type: 'string' },
    price_c: { type: 'integer' },
    price_display: { type: 'string' },
    contribution_c: { type: 'integer' },
    contribution_display: { type: 'string' },
  },
}

export const ORDER_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    mode_id: { type: 'integer' },
    mode_name: { type: 'string' },
    category: { type: 'string' },
    tech: { type: 'string' },
    duplex: { type: 'boolean' },
    paper_id: { type: 'integer' },
    paper_name: { type: 'string' },
    size_key: { type: 'string' },
    size_label: { type: 'string' },
    quantity: { type: 'integer' },
    unit_price_c: { type: 'integer' },
    unit_display: { type: 'string' },
    line_total: { type: 'integer' },
    line_total_display: { type: 'string' },
    has_file: { type: 'boolean' },
    file_status: { type: 'string' },
    file_note: { type: ['string', 'null'] },
    file_precheck: PRECHECK_SCHEMA,
    finishings: { type: 'array', items: ORDER_ITEM_FINISHING_SCHEMA },
    job_id: { type: ['string', 'null'] }, // admin 视图专用
    file_kind: { type: 'string' }, // admin 视图专用
  },
}

// ---------- D27 书行序列化（下单域：仅售价侧；mode_id 机器/job_id 仅 admin 视图） ----------

export const ORDER_BOOK_COMPONENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    role: { type: 'string' },
    paper_id: { type: 'integer' },
    paper_name: { type: 'string' },
    size_key: { type: 'string' },
    size_label: { type: 'string' },
    color_class: { type: 'string' },
    duplex: { type: 'boolean' },
    sheets_per_book: { type: 'integer' },
    unit_sell_c: { type: 'integer' },
    unit_display: { type: 'string' },
    has_file: { type: 'boolean' }, // D31 组件文件上传/审稿（两域售价侧；文件内容下载仍 owner/admin）
    file_status: { type: 'string' },
    file_note: { type: ['string', 'null'] },
    file_precheck: PRECHECK_SCHEMA, // D35 文件预检（advisory）
    source_component_id: { type: ['integer', 'null'] }, // D32 目录组件来源（中性引用，供再下单还原）
    mode_id: { type: 'integer' }, // admin 视图专用（机器对客户不可见）
    job_id: { type: ['string', 'null'] }, // admin 视图专用
    file_kind: { type: 'string' }, // admin 视图专用
  },
}

export const ORDER_BOOK_FINISHING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    finishing_id: { type: 'integer' },
    name: { type: 'string' },
    pricing: { type: 'string' },
    price_c: { type: 'integer' },
    price_display: { type: 'string' },
    contribution_c: { type: 'integer' },
    contribution_display: { type: 'string' },
  },
}

export const ORDER_BOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    book_id: { type: ['integer', 'null'] },
    name: { type: 'string' },
    count: { type: 'integer' },
    unit_price_c: { type: 'integer' },
    unit_display: { type: 'string' },
    line_total: { type: 'integer' },
    line_total_display: { type: 'string' },
    components: { type: 'array', items: ORDER_BOOK_COMPONENT_SCHEMA },
    finishings: { type: 'array', items: ORDER_BOOK_FINISHING_SCHEMA },
  },
}

// D28 收款流水（admin 视图专用；无 cost/profit/margin 字段）
export const PAYMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    amount: { type: 'integer' },
    amount_display: { type: 'string' },
    method: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
    created_at: { type: 'string' },
  },
}

export const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    order_number: { type: 'string' },
    status: { type: 'string' },
    access_token: { type: 'string' },
    is_guest: { type: 'boolean' }, // 访客单（下单域可见，用于「认领」入口）
    is_internal: { type: 'boolean' }, // admin 视图专用
    customer: {
      // admin 视图专用
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
        role: { type: 'string' },
      },
    },
    contact_info: { type: ['string', 'null'] },
    delivery_method: { type: 'string' }, // D30 'pickup' | 'shipping'
    delivery_address: { type: ['string', 'null'] },
    subtotal: { type: 'integer' },
    subtotal_display: { type: 'string' },
    discount: { type: 'integer' },
    discount_display: { type: 'string' },
    membership_discount: { type: 'integer' },
    membership_discount_display: { type: 'string' },
    membership_tier_name: { type: ['string', 'null'] },
    total: { type: 'integer' },
    total_display: { type: 'string' },
    payment_status: { type: 'string' },
    paid_amount: { type: 'integer' },
    paid_amount_display: { type: 'string' },
    refund_due: { type: 'integer' }, // PC2: 已取消且已收款时 = paid_amount（admin 视图；不自动退款，引导走退款流水）
    refund_due_display: { type: 'string' },
    payment_method: { type: ['string', 'null'] },
    paid_at: { type: ['string', 'null'] },
    quote_valid_until: { type: 'string' },
    quote_expired: { type: 'boolean' },
    created_at: { type: 'string' },
    confirmed_at: { type: ['string', 'null'] },
    due_date: { type: ['string', 'null'] },
    completed_at: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    items: { type: 'array', items: ORDER_ITEM_SCHEMA },
    books: { type: 'array', items: ORDER_BOOK_SCHEMA }, // D27 书行
    payments: { type: 'array', items: PAYMENT_SCHEMA }, // D28 收款流水（admin 视图专用）
  },
}

export interface DtoOptions {
  admin: boolean
  /** access_token 仅对 owner / by-token 调用方 / admin 回显 */
  includeToken: boolean
}

/** file_precheck 存 JSON TEXT；解析回对象（坏数据收敛为 null，不抛错） */
function parsePrecheck(raw: string | null): unknown {
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function itemDto(item: OrderItemRow, currency: Currency, opts: DtoOptions, finishings: OrderItemFinishingRow[] = []) {
  return {
    id: item.id,
    mode_id: item.mode_id,
    category: item.color_class.split(',')[0],
    tech: item.tech,
    duplex: item.duplex !== 0,
    paper_id: item.paper_id,
    paper_name: item.paper_name,
    size_key: item.size_key,
    size_label: item.size_label,
    quantity: item.quantity,
    unit_price_c: item.unit_price_c,
    unit_display: formatMoneyC(moneyC(item.unit_price_c), currency),
    line_total: item.line_total,
    line_total_display: formatMoney(money(item.line_total), currency),
    has_file: item.file_url != null,
    file_status: item.file_status,
    file_note: item.file_note,
    file_precheck: parsePrecheck(item.file_precheck),
    finishings: finishings.map((f) => ({
      finishing_id: f.finishing_id,
      name: f.name,
      pricing: f.pricing,
      price_c: f.price_c,
      price_display: formatMoneyC(moneyC(f.price_c), currency),
      contribution_c: f.contribution_c,
      contribution_display: formatMoneyC(moneyC(f.contribution_c), currency),
    })),
    ...(opts.admin
      ? { mode_name: item.mode_name, job_id: item.job_id, file_kind: item.file_url?.split('.').pop()?.toLowerCase() }
      : {}),
  }
}

/** D27 书行 DTO：售价侧字段；组件 mode_id（机器）与 job_id 仅 admin 视图暴露 */
export function bookDto(book: OrderBook, currency: Currency, opts: DtoOptions) {
  return {
    id: book.book.id,
    book_id: book.book.book_id,
    name: book.book.name,
    count: book.book.count,
    unit_price_c: book.book.unit_price_c,
    unit_display: formatMoneyC(moneyC(book.book.unit_price_c), currency),
    line_total: book.book.line_total,
    line_total_display: formatMoney(money(book.book.line_total), currency),
    components: book.components.map((c) => ({
      id: c.id,
      role: c.role,
      paper_id: c.paper_id,
      paper_name: c.paper_name,
      size_key: c.size_key,
      size_label: c.size_label,
      color_class: c.color_class,
      duplex: c.duplex !== 0,
      sheets_per_book: c.sheets_per_book,
      unit_sell_c: c.unit_sell_c,
      unit_display: formatMoneyC(moneyC(c.unit_sell_c), currency),
      has_file: c.file_url != null,
      file_status: c.file_status,
      file_note: c.file_note,
      file_precheck: parsePrecheck(c.file_precheck),
      source_component_id: c.source_component_id,
      ...(opts.admin ? { mode_id: c.mode_id, job_id: c.job_id, file_kind: c.file_url?.split('.').pop()?.toLowerCase() } : {}),
    })),
    finishings: book.finishings.map((f) => ({
      finishing_id: f.finishing_id,
      name: f.name,
      pricing: f.pricing,
      price_c: f.price_c,
      price_display: formatMoneyC(moneyC(f.price_c), currency),
      contribution_c: f.contribution_c,
      contribution_display: formatMoneyC(moneyC(f.contribution_c), currency),
    })),
  }
}

export function paymentDto(p: PaymentRow, currency: Currency) {
  return {
    id: p.id,
    kind: p.kind,
    amount: p.amount,
    amount_display: formatMoney(money(p.amount), currency),
    method: p.method,
    note: p.note,
    created_at: p.created_at,
  }
}

export function orderDto(db: DB, order: OrderRow, currency: Currency, opts: DtoOptions) {
  const items = getOrderItems(db, order.id)
  const books = getOrderBooks(db, order.id)
  const itemFins = getOrderItemFinishings(db, order.id)
  const finsByItem = new Map<string, OrderItemFinishingRow[]>()
  for (const f of itemFins) {
    let arr = finsByItem.get(f.order_item_id)
    if (!arr) { arr = []; finsByItem.set(f.order_item_id, arr) }
    arr.push(f)
  }
  const base = {
    id: order.id,
    order_number: order.order_number,
    status: order.status,
    contact_info: order.contact_info,
    delivery_method: order.delivery_method,
    delivery_address: order.delivery_address,
    subtotal: order.subtotal,
    subtotal_display: formatMoney(money(order.subtotal), currency),
    discount: order.discount,
    discount_display: formatMoney(money(order.discount), currency),
    membership_discount: order.membership_discount,
    membership_discount_display: formatMoney(money(order.membership_discount), currency),
    membership_tier_name: order.membership_tier_id
      ? ((db.prepare('SELECT name FROM membership_tiers WHERE id = ?').get(order.membership_tier_id) as { name: string } | undefined)?.name ?? null)
      : null,
    total: order.total,
    total_display: formatMoney(money(order.total), currency),
    payment_status: order.payment_status,
    paid_amount: order.paid_amount,
    paid_amount_display: formatMoney(money(order.paid_amount), currency),
    payment_method: order.payment_method,
    paid_at: order.paid_at,
    quote_valid_until: order.quote_valid_until,
    // confirm 之前（quoted/审稿中）报价时效都有意义；confirmed 起价格已定格履约
    quote_expired:
      ['quoted', 'file_pending', 'file_approved'].includes(order.status) &&
      new Date().toISOString() > order.quote_valid_until,
    created_at: order.created_at,
    confirmed_at: order.confirmed_at,
    due_date: order.due_date,
    completed_at: order.completed_at,
    notes: order.notes,
    is_guest: order.customer_id === GUEST_SENTINEL_ID,
    items: items.map((i) => itemDto(i, currency, opts, finsByItem.get(i.id) ?? [])),
    books: books.map((b) => bookDto(b, currency, opts)),
  }
  if (opts.includeToken) Object.assign(base, { access_token: order.access_token })
  if (opts.admin) {
    // 访客单展示 guest_* 身份（哨兵用户本身无意义）
    const customer =
      order.customer_id === GUEST_SENTINEL_ID
        ? { id: 'guest', name: order.guest_name ?? '访客', email: order.guest_email ?? '', role: 'guest' }
        : (db
            .prepare('SELECT id, name, email, role FROM users WHERE id = ?')
            .get(order.customer_id) as { id: string; name: string; email: string; role: string } | undefined)
    Object.assign(base, { is_internal: order.is_internal !== 0, customer })
    // D28 收款流水（admin 视图：账实可对）
    Object.assign(base, {
      payments: getPayments(db, order.id).map((p) => paymentDto(p, currency)),
    })
    // PC2 取消含已收款：不自动退款，提示须退额（=已收）引导走退款流水
    const refundDue = order.status === 'cancelled' ? order.paid_amount : 0
    Object.assign(base, {
      refund_due: refundDue,
      refund_due_display: formatMoney(money(refundDue), currency),
    })
  }
  return base
}
