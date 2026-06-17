import { type FastifyInstance } from 'fastify'
import { audit } from './audit.js'
import { getLog } from './logger.js'
import { type BookLineInput, type BookSpecInput } from './books.js'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { assertJobCounts, assertOrderItemRow, assertOrderRow, assertPaymentRow, assertRows } from './db-guards.js'
import { ERROR_SCHEMA } from './errors.js'
import { requireAdmin, requireUser } from './guards.js'
import { formatMoney, money, type Currency } from './money.js'
import { notifyAddress, notifyUser, templates } from './notify.js'
import {
  bookDto,
  type DtoOptions,
  itemDto,
  ORDER_SCHEMA,
  orderDto,
  paymentDto,
} from './order-dto.js'
import {
  adminCanTransition,
  cancelOrder,
  claimGuestOrder,
  confirmOrder,
  createOrder,
  CUSTOMER_CANCELLABLE,
  getOrder,
  GUEST_SENTINEL_ID,
  syncFileState,
  type OrderBook,
  type OrderItemFinishingRow,
  type OrderItemRow,
  type OrderRow,
} from './orders.js'
import { checkAutoUpgrade } from './membership.js'
import { getPayments, PaymentError, projectStatus, recordPayment, type PaymentRow } from './payments.js'

// Re-export from shared module for backward compatibility
export { ORDER_SCHEMA, orderDto, type DtoOptions } from './order-dto.js'
export { PRECHECK_SCHEMA, ORDER_ITEM_SCHEMA, ORDER_BOOK_COMPONENT_SCHEMA, ORDER_BOOK_FINISHING_SCHEMA, ORDER_BOOK_SCHEMA, PAYMENT_SCHEMA } from './order-dto.js'


// ---------- 下单请求行（单页 item + D27 书行），两个下单端点共用 ----------

const ITEM_LINE_SCHEMA = {
  type: 'object',
  required: ['mode_id', 'paper_id', 'size_key', 'quantity'],
  additionalProperties: false,
  properties: {
    mode_id: { type: 'integer', minimum: 1 },
    paper_id: { type: 'integer', minimum: 1 },
    size_key: { type: 'string', minLength: 1, maxLength: 20 },
    quantity: { type: 'integer', minimum: 1, maximum: 1000000 },
    finishing_ids: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1 } },
  },
}

const BOOK_LINE_SCHEMA = {
  type: 'object',
  required: ['book_id', 'count'],
  additionalProperties: false,
  properties: {
    book_id: { type: 'integer', minimum: 1 },
    count: { type: 'integer', minimum: 1, maximum: 1000000 },
    // 客户为每个内页/插图组件填每本张数（封面忽略=固定 1；插图缺省=不含）
    components: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        required: ['component_id', 'sheets_per_book'],
        additionalProperties: false,
        properties: {
          component_id: { type: 'integer', minimum: 1 },
          sheets_per_book: { type: 'integer', minimum: 1, maximum: 1000000 },
        },
      },
    },
  },
}

const CUSTOM_BOOK_LINE_SCHEMA = {
  type: 'object',
  required: ['count', 'size_key', 'components'],
  additionalProperties: false,
  properties: {
    count: { type: 'integer', minimum: 1, maximum: 1000000 },
    size_key: { type: 'string', minLength: 1 },
    components: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['role', 'paper_id', 'color_class', 'duplex'],
        additionalProperties: false,
        properties: {
          role: { type: 'string', enum: ['cover', 'inner', 'insert'] },
          paper_id: { type: 'integer', minimum: 1 },
          color_class: { type: 'string', minLength: 1 },
          duplex: { type: 'integer', enum: [0, 1] },
          sheets_per_book: { type: 'integer', minimum: 1, maximum: 1000000 },
        },
      },
    },
    finishing_ids: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1 } },
  },
}

interface OrderLineBody {
  items?: Array<{ mode_id: number; paper_id: number; size_key: string; quantity: number }>
  books?: Array<{ book_id: number; count: number; components?: Array<{ component_id: number; sheets_per_book: number }> }>
  custom_books?: Array<{
    count: number; size_key: string
    components: Array<{ role: 'cover' | 'inner' | 'insert'; paper_id: number; color_class: string; duplex: number; sheets_per_book?: number }>
    finishing_ids?: number[]
  }>
}

/** 请求体书行 → createOrder 的 BookLineInput（components 数组转 sheets record） */
function toBookLines(books: OrderLineBody['books']): BookLineInput[] {
  return (books ?? []).map((bk) => ({
    book_id: bk.book_id,
    count: bk.count,
    sheets: Object.fromEntries((bk.components ?? []).map((c) => [c.component_id, c.sheets_per_book])),
  }))
}

function toCustomBookSpecs(cbs: OrderLineBody['custom_books']): BookSpecInput[] {
  return (cbs ?? []).map((cb) => ({
    count: cb.count,
    size_key: cb.size_key,
    components: cb.components,
    finishing_ids: cb.finishing_ids ?? [],
  }))
}

function batchOrderDtos(db: DB, orders: OrderRow[], currency: Currency, opts: DtoOptions) {
  if (orders.length === 0) return []
  const ids = orders.map((o) => o.id)
  const ph = ids.map(() => '?').join(',')

  const allItems = db
    .prepare(
      `SELECT oi.*, m.name AS mode_name, p.name AS paper_name, s.label AS size_label,
              COALESCE(m.color_class, 'color') AS color_class, pr.type AS tech, m.duplex
       FROM order_items oi
       JOIN print_modes m ON m.id = oi.mode_id
       JOIN printers pr ON pr.id = m.printer_id
       JOIN papers p ON p.id = oi.paper_id
       JOIN sizes s ON s.key = oi.size_key
       WHERE oi.order_id IN (${ph})
       ORDER BY oi.rowid`,
    )
    .all(...ids) as OrderItemRow[]
  assertRows(allItems as unknown as Array<Record<string, unknown>>, assertOrderItemRow, 'batchItems')
  const itemsByOrder = new Map<string, OrderItemRow[]>()
  for (const it of allItems) {
    let arr = itemsByOrder.get(it.order_id)
    if (!arr) { arr = []; itemsByOrder.set(it.order_id, arr) }
    arr.push(it)
  }

  const allItemFins = db
    .prepare(
      `SELECT oif.*
       FROM order_item_finishings oif
       JOIN order_items oi ON oi.id = oif.order_item_id
       WHERE oi.order_id IN (${ph})
       ORDER BY oif.rowid`,
    )
    .all(...ids) as OrderItemFinishingRow[]
  const finsByItem = new Map<string, OrderItemFinishingRow[]>()
  for (const f of allItemFins) {
    let arr = finsByItem.get(f.order_item_id)
    if (!arr) { arr = []; finsByItem.set(f.order_item_id, arr) }
    arr.push(f)
  }

  const allBooks = db
    .prepare(`SELECT * FROM order_books WHERE order_id IN (${ph}) ORDER BY rowid`)
    .all(...ids) as import('./orders.js').OrderBookRow[]
  const bookIds = allBooks.map((b) => b.id)
  const booksByOrder = new Map<string, import('./orders.js').OrderBookRow[]>()
  for (const b of allBooks) {
    let arr = booksByOrder.get(b.order_id)
    if (!arr) { arr = []; booksByOrder.set(b.order_id, arr) }
    arr.push(b)
  }

  const compsByBook = new Map<string, import('./orders.js').OrderBookComponentRow[]>()
  const finsByBook = new Map<string, import('./orders.js').OrderBookFinishingRow[]>()
  if (bookIds.length > 0) {
    const bph = bookIds.map(() => '?').join(',')
    const allComps = db
      .prepare(
        `SELECT obc.*, p.name AS paper_name, s.label AS size_label
         FROM order_book_components obc
         JOIN papers p ON p.id = obc.paper_id
         JOIN sizes s ON s.key = obc.size_key
         WHERE obc.order_book_id IN (${bph})
         ORDER BY obc.rowid`,
      )
      .all(...bookIds) as import('./orders.js').OrderBookComponentRow[]
    for (const c of allComps) {
      let arr = compsByBook.get(c.order_book_id)
      if (!arr) { arr = []; compsByBook.set(c.order_book_id, arr) }
      arr.push(c)
    }
    const allFins = db
      .prepare(
        `SELECT * FROM order_book_finishings WHERE order_book_id IN (${bph}) ORDER BY rowid`,
      )
      .all(...bookIds) as import('./orders.js').OrderBookFinishingRow[]
    for (const f of allFins) {
      let arr = finsByBook.get(f.order_book_id)
      if (!arr) { arr = []; finsByBook.set(f.order_book_id, arr) }
      arr.push(f)
    }
  }

  const tierIds = [...new Set(orders.map((o) => o.membership_tier_id).filter((id): id is number => id != null))]
  const tierMap = new Map<number, string>()
  if (tierIds.length > 0) {
    const tph = tierIds.map(() => '?').join(',')
    const tiers = db.prepare(`SELECT id, name FROM membership_tiers WHERE id IN (${tph})`).all(...tierIds) as Array<{ id: number; name: string }>
    for (const t of tiers) tierMap.set(t.id, t.name)
  }

  let userMap: Map<string, { id: string; name: string; email: string; role: string }> | undefined
  let paymentsByOrder: Map<string, PaymentRow[]> | undefined
  if (opts.admin) {
    const custIds = [...new Set(orders.map((o) => o.customer_id).filter((id) => id !== GUEST_SENTINEL_ID))]
    userMap = new Map()
    if (custIds.length > 0) {
      const uph = custIds.map(() => '?').join(',')
      const users = db
        .prepare(`SELECT id, name, email, role FROM users WHERE id IN (${uph})`)
        .all(...custIds) as Array<{ id: string; name: string; email: string; role: string }>
      for (const u of users) userMap.set(u.id, u)
    }
    paymentsByOrder = new Map()
    const allPayments = db
      .prepare(`SELECT * FROM payments WHERE order_id IN (${ph}) ORDER BY created_at, rowid`)
      .all(...ids) as PaymentRow[]
    assertRows(allPayments as unknown as Array<Record<string, unknown>>, assertPaymentRow, 'batchPayments')
    for (const p of allPayments) {
      let arr = paymentsByOrder.get(p.order_id)
      if (!arr) { arr = []; paymentsByOrder.set(p.order_id, arr) }
      arr.push(p)
    }
  }

  return orders.map((order) => {
    const items = itemsByOrder.get(order.id) ?? []
    const books: OrderBook[] = (booksByOrder.get(order.id) ?? []).map((book) => ({
      book,
      components: compsByBook.get(book.id) ?? [],
      finishings: finsByBook.get(book.id) ?? [],
    }))
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
      membership_tier_name: order.membership_tier_id ? (tierMap.get(order.membership_tier_id) ?? null) : null,
      total: order.total,
      total_display: formatMoney(money(order.total), currency),
      payment_status: order.payment_status,
      paid_amount: order.paid_amount,
      paid_amount_display: formatMoney(money(order.paid_amount), currency),
      payment_method: order.payment_method,
      paid_at: order.paid_at,
      quote_valid_until: order.quote_valid_until,
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
      const customer =
        order.customer_id === GUEST_SENTINEL_ID
          ? { id: 'guest', name: order.guest_name ?? '访客', email: order.guest_email ?? '', role: 'guest' }
          : userMap!.get(order.customer_id)
      Object.assign(base, { is_internal: order.is_internal !== 0, customer })
      Object.assign(base, {
        payments: (paymentsByOrder!.get(order.id) ?? []).map((p) => paymentDto(p, currency)),
      })
      const refundDue = order.status === 'cancelled' ? order.paid_amount : 0
      Object.assign(base, {
        refund_due: refundDue,
        refund_due_display: formatMoney(money(refundDue), currency),
      })
    }
    return base
  })
}

export function registerOrdersRoutes(app: FastifyInstance, db: DB): void {
  // ---------- 下单域: 下单 ----------

  app.post(
    '/api/orders',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          // items 与 books 均可选，但至少一行（空单由 createOrder 422 empty_order）
          additionalProperties: false,
          properties: {
            items: { type: 'array', maxItems: 50, items: ITEM_LINE_SCHEMA },
            books: { type: 'array', maxItems: 50, items: BOOK_LINE_SCHEMA },
            custom_books: { type: 'array', maxItems: 50, items: CUSTOM_BOOK_LINE_SCHEMA },
            contact_info: { type: ['string', 'null'], maxLength: 200 },
            notes: { type: ['string', 'null'], maxLength: 2000 },
            delivery_method: { type: 'string', enum: ['pickup', 'shipping'] },
            delivery_address: { type: ['string', 'null'], maxLength: 500 },
          },
        },
        response: { 201: ORDER_SCHEMA, 403: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const user = req.user as NonNullable<typeof req.user>
      // D17: 仅当实例开启「要求邮箱验证」时,未验证邮箱才禁止下单(默认关)
      const cfg = db
        .prepare('SELECT require_email_verification FROM system_config WHERE id = 1')
        .get() as { require_email_verification: number }
      if (cfg.require_email_verification === 1 && user.email_verified_at == null) {
        return reply.status(403).send({ error: 'email_unverified' })
      }
      const b = req.body as OrderLineBody & {
        contact_info?: string | null
        notes?: string | null
        delivery_method?: 'pickup' | 'shipping'
        delivery_address?: string | null
      }
      // OrderError/BookError（422 not_quotable / empty_order / delivery_address_required 等）带 statusCode 上抛
      const orderId = createOrder(db, {
        customerId: user.id,
        // B1.1: 内部成员（member/admin）下单走内部价口径并标记 is_internal
        internal: user.role !== 'customer',
        items: b.items ?? [],
        books: toBookLines(b.books),
        customBooks: toCustomBookSpecs(b.custom_books),
        contactInfo: b.contact_info ?? null,
        notes: b.notes ?? null,
        deliveryMethod: b.delivery_method ?? 'pickup',
        deliveryAddress: b.delivery_address ?? null,
      })
      const order = getOrder(db, orderId) as OrderRow
      return reply
        .status(201)
        .send(orderDto(db, order, baseCurrency(db), { admin: false, includeToken: true }))
    },
  )

  // ---------- 下单域: 免登录（访客）下单（D23，behind guest_orders_open） ----------

  app.post(
    '/api/orders/guest',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'name'],
          additionalProperties: false,
          properties: {
            items: { type: 'array', maxItems: 50, items: ITEM_LINE_SCHEMA },
            books: { type: 'array', maxItems: 50, items: BOOK_LINE_SCHEMA },
            custom_books: { type: 'array', maxItems: 50, items: CUSTOM_BOOK_LINE_SCHEMA },
            email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            contact_info: { type: ['string', 'null'], maxLength: 200 },
            notes: { type: ['string', 'null'], maxLength: 2000 },
            delivery_method: { type: 'string', enum: ['pickup', 'shipping'] },
            delivery_address: { type: ['string', 'null'], maxLength: 500 },
          },
        },
        response: { 201: ORDER_SCHEMA, 403: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const open = db.prepare('SELECT guest_orders_open FROM system_config WHERE id = 1').get() as
        | { guest_orders_open: number }
        | undefined
      if (!open || open.guest_orders_open === 0) {
        return reply.status(403).send({ error: 'guest_orders_closed' })
      }
      const b = req.body as OrderLineBody & {
        email: string
        name: string
        contact_info?: string | null
        notes?: string | null
        delivery_method?: 'pickup' | 'shipping'
        delivery_address?: string | null
      }
      const orderId = createOrder(db, {
        customerId: GUEST_SENTINEL_ID,
        internal: false,
        items: b.items ?? [],
        books: toBookLines(b.books),
        customBooks: toCustomBookSpecs(b.custom_books),
        contactInfo: b.contact_info ?? null,
        notes: b.notes ?? null,
        deliveryMethod: b.delivery_method ?? 'pickup',
        deliveryAddress: b.delivery_address ?? null,
        guestEmail: b.email,
        guestName: b.name,
        guestContact: b.contact_info ?? null,
      })
      const order = getOrder(db, orderId) as OrderRow
      return reply
        .status(201)
        .send(orderDto(db, order, baseCurrency(db), { admin: false, includeToken: true }))
    },
  )

  // D23: 已验证用户认领访客单（仅当本人已验证邮箱 == guest_email）；改绑后并入其历史
  app.post(
    '/api/orders/by-token/:token/claim',
    {
      preHandler: requireUser,
      schema: {
        params: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 100 } },
        },
        response: { 200: ORDER_SCHEMA, 403: ERROR_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const user = req.user as NonNullable<typeof req.user>
      const { token } = req.params as { token: string }
      const order = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token) as OrderRow | undefined
      if (!order) return reply.status(404).send({ error: 'not_found' })
      if (order.customer_id !== GUEST_SENTINEL_ID) {
        return reply.status(409).send({ error: 'not_a_guest_order' })
      }
      // 认领安全边界：本人邮箱须已验证且与 guest_email 一致（token 本身不足以改绑归属）
      if (user.email_verified_at == null) {
        return reply.status(403).send({ error: 'verify_email_to_claim' })
      }
      if ((order.guest_email ?? '').toLowerCase() !== user.email.toLowerCase()) {
        return reply.status(403).send({ error: 'email_mismatch' })
      }
      claimGuestOrder(db, order.id, user.id)
      const updated = getOrder(db, order.id) as OrderRow
      return orderDto(db, updated, baseCurrency(db), { admin: false, includeToken: true })
    },
  )

  // ---------- 下单域: 列表 / 单查 ----------

  app.get(
    '/api/orders',
    {
      preHandler: requireUser,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: [
                'quoted',
                'file_pending',
                'file_approved',
                'confirmed',
                'in_production',
                'printed',
                'ready',
                'delivered',
                'cancelled',
              ],
            },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      const user = req.user as NonNullable<typeof req.user>
      const { status, offset = 0, limit = 50 } = req.query as { status?: string; offset?: number; limit?: number }
      const currency = baseCurrency(db)
      const admin = user.role === 'admin'
      const where: string[] = []
      const params: unknown[] = []
      if (!admin) {
        where.push('customer_id = ?')
        params.push(user.id)
      }
      if (status) {
        where.push('status = ?')
        params.push(status)
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM orders ${clause}`).get(...params) as { n: number }).n
      const rows = db
        .prepare(`SELECT * FROM orders ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as OrderRow[]
      assertRows(rows as unknown as Array<Record<string, unknown>>, assertOrderRow, 'orderList')
      return { data: batchOrderDtos(db, rows, currency, { admin, includeToken: true }), total }
    },
  )

  app.get(
    '/api/orders/by-token/:token',
    {
      // 防枚举：随机 access_token 查询，错误一律 404；公开端点限流
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 100 } },
        },
        response: { 200: ORDER_SCHEMA, 404: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { token } = req.params as { token: string }
      const order = db.prepare('SELECT * FROM orders WHERE access_token = ?').get(token) as
        | OrderRow
        | undefined
      if (!order) return reply.status(404).send({ error: 'not_found' })
      return orderDto(db, order, baseCurrency(db), { admin: false, includeToken: true })
    },
  )

  app.get(
    '/api/orders/:id',
    {
      preHandler: requireUser,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: ORDER_SCHEMA, 404: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const user = req.user as NonNullable<typeof req.user>
      const { id } = req.params as { id: string }
      const order = getOrder(db, id)
      const admin = user.role === 'admin'
      // 他人订单一律 404（不泄露存在性，§6）
      if (!order || (!admin && order.customer_id !== user.id)) {
        return reply.status(404).send({ error: 'not_found' })
      }
      return orderDto(db, order, baseCurrency(db), { admin, includeToken: true })
    },
  )

  // ---------- 状态流转 ----------

  app.patch(
    '/api/orders/:id/status',
    {
      preHandler: requireUser,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: {
            // file_pending / file_approved 由系统自动流转，不可手动指定
            status: {
              type: 'string',
              enum: ['confirmed', 'in_production', 'printed', 'ready', 'delivered', 'cancelled'],
            },
          },
        },
        response: { 200: ORDER_SCHEMA, 403: ERROR_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const user = req.user as NonNullable<typeof req.user>
      const { id } = req.params as { id: string }
      const { status } = req.body as { status: string }
      const admin = user.role === 'admin'
      const order = getOrder(db, id)
      if (!order || (!admin && order.customer_id !== user.id)) {
        return reply.status(404).send({ error: 'not_found' })
      }

      if (!admin) {
        // customer/member 仅可取消自己的单，confirmed 起仅 admin
        if (status !== 'cancelled') return reply.status(403).send({ error: 'forbidden' })
        if (!CUSTOMER_CANCELLABLE.includes(order.status)) {
          return reply.status(409).send({ error: `not_cancellable_from_${order.status}` })
        }
        cancelOrder(db, id)
      } else if (status === 'cancelled') {
        cancelOrder(db, id)
      } else if (status === 'confirmed') {
        confirmOrder(db, id)
      } else {
        if (!adminCanTransition(order.status, status)) {
          return reply.status(409).send({ error: `invalid_transition_${order.status}_to_${status}` })
        }
        if (status === 'printed' || status === 'ready' || status === 'delivered') {
          const jobCounts = db
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
            .get(id, id) as { pending: number; done: number }
          assertJobCounts(jobCounts as unknown as Record<string, unknown>)
          if (jobCounts.pending > 0) {
            return reply.status(409).send({ error: 'jobs_not_completed' })
          }
          if (jobCounts.done === 0) {
            return reply.status(409).send({ error: 'no_completed_jobs' })
          }
          if (status === 'delivered') {
            db.prepare("UPDATE orders SET status = 'delivered', completed_at = ? WHERE id = ?").run(
              new Date().toISOString(),
              id,
            )
            try { checkAutoUpgrade(db, order.customer_id) } catch (e) { getLog().warn({ err: e, orderId: id }, 'checkAutoUpgrade failed (non-blocking)') }
          } else {
            db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id)
          }
        } else {
          db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id)
        }
      }
      const updated = getOrder(db, id) as OrderRow
      const currency = baseCurrency(db)
      // PC1: 订单状态流转留痕（confirm/cancel）。cancel 附已收额提示须退款额（PC2）
      if (status === 'confirmed' || status === 'cancelled') {
        audit(db, {
          actorId: req.user?.id ?? null,
          action: status === 'confirmed' ? 'order.confirm' : 'order.cancel',
          targetType: 'order',
          targetId: id,
          summary:
            status === 'confirmed'
              ? `确认 ${order.order_number} · 建作业`
              : `取消 ${order.order_number}（${order.status}→cancelled）${
                  order.paid_amount > 0 ? ` · 须退 ${order.paid_amount}` : ''
                }`,
        })
      }
      // R7: confirm/ready 通知客户（分发永不抛错，状态流转不被通知阻塞）。
      // 访客单走 guest_email 直发（哨兵用户 archived，notifyUser 不投递）
      const notifyParty = async (event: 'order_confirmed' | 'order_ready', msg: ReturnType<typeof templates.orderReady>) => {
        if (updated.guest_email) await notifyAddress(db, event, updated.guest_email, msg)
        else await notifyUser(db, event, updated.customer_id, msg)
      }
      if (status === 'confirmed') {
        await notifyParty(
          'order_confirmed',
          templates.orderConfirmed(updated.order_number, formatMoney(money(updated.total), currency)),
        )
      } else if (status === 'ready') {
        await notifyParty('order_ready', templates.orderReady(updated.order_number))
      }
      return orderDto(db, updated, currency, { admin, includeToken: true })
    },
  )

  // ---------- 管理域: 审稿（R1 定点：逐 item，全 approved → file_approved，任一 rejected → 留 file_pending） ----------

  app.patch(
    '/api/orders/:id/items/:iid/file-review',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'iid'],
          properties: { id: { type: 'string' }, iid: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['file_status'],
          additionalProperties: false,
          properties: {
            file_status: { type: 'string', enum: ['approved', 'rejected'] },
            file_note: { type: ['string', 'null'], maxLength: 1000 },
          },
        },
        response: { 200: ORDER_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id, iid } = req.params as { id: string; iid: string }
      const b = req.body as { file_status: 'approved' | 'rejected'; file_note?: string | null }
      const order = getOrder(db, id)
      if (!order) return reply.status(404).send({ error: 'not_found' })
      if (!['quoted', 'file_pending', 'file_approved'].includes(order.status)) {
        return reply.status(409).send({ error: `not_reviewable_from_${order.status}` })
      }
      const item = db
        .prepare('SELECT id, file_url FROM order_items WHERE id = ? AND order_id = ?')
        .get(iid, id) as { id: string; file_url: string | null } | undefined
      if (!item) return reply.status(404).send({ error: 'not_found' })
      if (item.file_url == null) return reply.status(409).send({ error: 'no_file_to_review' })

      db.prepare('UPDATE order_items SET file_status = ?, file_note = ? WHERE id = ?').run(
        b.file_status,
        b.file_note ?? null,
        iid,
      )
      syncFileState(db, id)
      const updated = getOrder(db, id) as OrderRow
      // 驳回须通知客户重传（否则订单无声卡在 file_pending）；分发永不抛错
      if (b.file_status === 'rejected') {
        await notifyUser(
          db,
          'order_file_rejected',
          updated.customer_id,
          templates.orderFileRejected(updated.order_number, b.file_note ?? null),
        )
      }
      return orderDto(db, updated, baseCurrency(db), { admin: true, includeToken: true })
    },
  )

  // ---------- 管理域: 书组件审稿（D31：与单页 item 同口径，全 approved → file_approved，任一 rejected → 留 file_pending） ----------

  app.patch(
    '/api/orders/:id/book-components/:cid/file-review',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'cid'],
          properties: { id: { type: 'string' }, cid: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['file_status'],
          additionalProperties: false,
          properties: {
            file_status: { type: 'string', enum: ['approved', 'rejected'] },
            file_note: { type: ['string', 'null'], maxLength: 1000 },
          },
        },
        response: { 200: ORDER_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string }
      const b = req.body as { file_status: 'approved' | 'rejected'; file_note?: string | null }
      const order = getOrder(db, id)
      if (!order) return reply.status(404).send({ error: 'not_found' })
      if (!['quoted', 'file_pending', 'file_approved'].includes(order.status)) {
        return reply.status(409).send({ error: `not_reviewable_from_${order.status}` })
      }
      const comp = db
        .prepare(
          `SELECT obc.id, obc.file_url
           FROM order_book_components obc
           JOIN order_books ob ON ob.id = obc.order_book_id
           WHERE obc.id = ? AND ob.order_id = ?`,
        )
        .get(cid, id) as { id: string; file_url: string | null } | undefined
      if (!comp) return reply.status(404).send({ error: 'not_found' })
      if (comp.file_url == null) return reply.status(409).send({ error: 'no_file_to_review' })

      db.prepare('UPDATE order_book_components SET file_status = ?, file_note = ? WHERE id = ?').run(
        b.file_status,
        b.file_note ?? null,
        cid,
      )
      syncFileState(db, id)
      const updated = getOrder(db, id) as OrderRow
      if (b.file_status === 'rejected') {
        await notifyUser(
          db,
          'order_file_rejected',
          updated.customer_id,
          templates.orderFileRejected(updated.order_number, b.file_note ?? null),
        )
      }
      return orderDto(db, updated, baseCurrency(db), { admin: true, includeToken: true })
    },
  )

  // ---------- 管理域: 收款流水（D28：append-only payments，paid_amount/status 为其投影） ----------

  app.get(
    '/api/orders/:id/payments',
    {
      preHandler: requireAdmin,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!getOrder(db, id)) return reply.status(404).send({ error: 'not_found' })
      const currency = baseCurrency(db)
      return getPayments(db, id).map((p) => paymentDto(p, currency))
    },
  )

  app.post(
    '/api/orders/:id/payments',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['kind', 'amount'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['deposit', 'balance', 'refund'] },
            // 带符号整数：收款(deposit/balance)正、退款(refund)负。1.5/"100" 由 schema 422（coerceTypes 关）
            amount: { type: 'integer' },
            method: { type: ['string', 'null'], maxLength: 50 },
            note: { type: ['string', 'null'], maxLength: 500 },
          },
        },
        response: { 201: ORDER_SCHEMA, 404: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!getOrder(db, id)) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as { kind: 'deposit' | 'balance' | 'refund'; amount: number; method?: string | null; note?: string | null }
      try {
        // PaymentError 仅 422（超付/退过/kind 符号不一致）；order 已存在故不会 404
        recordPayment(db, id, { kind: b.kind, amount: b.amount, method: b.method ?? null, note: b.note ?? null, operatorId: req.user?.id ?? null })
      } catch (err) {
        if (err instanceof PaymentError) return reply.status(422).send({ error: err.message })
        throw err
      }
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'payment.record',
        targetType: 'order',
        targetId: id,
        summary: `${b.kind} ${b.amount}${b.method ? ` · ${b.method}` : ''}`,
      })
      const updated = getOrder(db, id) as OrderRow
      return reply.status(201).send(orderDto(db, updated, baseCurrency(db), { admin: true, includeToken: true }))
    },
  )

  app.patch(
    '/api/orders/:id/discount',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['discount'],
          additionalProperties: false,
          // 非整数（1.5/"100"）→ schema 422；负数 → minimum 422；超 subtotal → 手工 422
          properties: { discount: { type: 'integer', minimum: 0 } },
        },
        response: { 200: ORDER_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { discount } = req.body as { discount: number }
      const order = getOrder(db, id)
      if (!order) return reply.status(404).send({ error: 'not_found' })
      if (!['quoted', 'file_pending', 'file_approved'].includes(order.status)) {
        return reply.status(409).send({ error: `not_editable_from_${order.status}` })
      }
      const maxDiscount = order.subtotal - order.membership_discount
      if (discount > maxDiscount) {
        return reply.status(422).send({ error: 'discount_exceeds_subtotal' })
      }
      // D28: 折扣不可把应付压到已收之下（否则 paid_amount > total，投影失真，须先退款）
      const newTotal = order.subtotal - discount - order.membership_discount
      if (newTotal < order.paid_amount) {
        return reply.status(422).send({ error: 'discount_below_paid' })
      }
      // total = subtotal − discount：整数减法，无舍入；并重算 payment_status 投影（应付变了，paid_amount 未变）
      db.prepare('UPDATE orders SET discount = ?, total = ?, payment_status = ? WHERE id = ?').run(
        discount,
        newTotal,
        projectStatus(order.paid_amount, newTotal),
        id,
      )
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'order.discount',
        targetType: 'order',
        targetId: id,
        summary: `折扣 ${order.discount} → ${discount}`,
      })
      const updated = getOrder(db, id) as OrderRow
      return orderDto(db, updated, baseCurrency(db), { admin: true, includeToken: true })
    },
  )
}
