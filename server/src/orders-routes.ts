import { type FastifyInstance } from 'fastify'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { requireAdmin, requireUser } from './guards.js'
import { formatMoney, formatMoneyC, money, moneyC, type Currency } from './money.js'
import { notifyAddress, notifyUser, templates } from './notify.js'
import {
  adminCanTransition,
  cancelOrder,
  claimGuestOrder,
  confirmOrder,
  createOrder,
  CUSTOMER_CANCELLABLE,
  getOrder,
  getOrderItems,
  GUEST_SENTINEL_ID,
  OrderError,
  syncFileState,
  type OrderItemRow,
  type OrderRow,
} from './orders.js'

// ---------- 序列化白名单（D5/§6）：下单域响应仅含售价侧字段，cost/profit/margin 不进 schema ----------

export const ORDER_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    mode_id: { type: 'integer' },
    mode_name: { type: 'string' },
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
    job_id: { type: ['string', 'null'] }, // admin 视图专用
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
    subtotal: { type: 'integer' },
    subtotal_display: { type: 'string' },
    discount: { type: 'integer' },
    discount_display: { type: 'string' },
    total: { type: 'integer' },
    total_display: { type: 'string' },
    payment_status: { type: 'string' },
    paid_amount: { type: 'integer' },
    paid_amount_display: { type: 'string' },
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
  },
}

const ORDER_LIST_SCHEMA = { type: 'array', items: ORDER_SCHEMA }

export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { error: { type: 'string' }, message: { type: 'string' } },
}

export interface DtoOptions {
  admin: boolean
  /** access_token 仅对 owner / by-token 调用方 / admin 回显 */
  includeToken: boolean
}

function itemDto(item: OrderItemRow, currency: Currency, opts: DtoOptions) {
  return {
    id: item.id,
    mode_id: item.mode_id,
    mode_name: item.mode_name,
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
    ...(opts.admin ? { job_id: item.job_id } : {}),
  }
}

export function orderDto(db: DB, order: OrderRow, currency: Currency, opts: DtoOptions) {
  const items = getOrderItems(db, order.id)
  const base = {
    id: order.id,
    order_number: order.order_number,
    status: order.status,
    contact_info: order.contact_info,
    subtotal: order.subtotal,
    subtotal_display: formatMoney(money(order.subtotal), currency),
    discount: order.discount,
    discount_display: formatMoney(money(order.discount), currency),
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
    items: items.map((i) => itemDto(i, currency, opts)),
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
  }
  return base
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
          required: ['items'],
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['mode_id', 'paper_id', 'size_key', 'quantity'],
                additionalProperties: false,
                properties: {
                  mode_id: { type: 'integer', minimum: 1 },
                  paper_id: { type: 'integer', minimum: 1 },
                  size_key: { type: 'string', minLength: 1, maxLength: 20 },
                  quantity: { type: 'integer', minimum: 1, maximum: 1000000 },
                },
              },
            },
            contact_info: { type: ['string', 'null'], maxLength: 200 },
            notes: { type: ['string', 'null'], maxLength: 2000 },
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
      const b = req.body as {
        items: Array<{ mode_id: number; paper_id: number; size_key: string; quantity: number }>
        contact_info?: string | null
        notes?: string | null
      }
      // OrderError（422 item_not_quotable 等）带 statusCode 上抛，全局 errorHandler 映射
      const orderId = createOrder(db, {
        customerId: user.id,
        // B1.1: 内部成员（member/admin）下单走内部价口径并标记 is_internal
        internal: user.role !== 'customer',
        items: b.items,
        contactInfo: b.contact_info ?? null,
        notes: b.notes ?? null,
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
          required: ['items', 'email', 'name'],
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['mode_id', 'paper_id', 'size_key', 'quantity'],
                additionalProperties: false,
                properties: {
                  mode_id: { type: 'integer', minimum: 1 },
                  paper_id: { type: 'integer', minimum: 1 },
                  size_key: { type: 'string', minLength: 1, maxLength: 20 },
                  quantity: { type: 'integer', minimum: 1, maximum: 1000000 },
                },
              },
            },
            email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            contact_info: { type: ['string', 'null'], maxLength: 200 },
            notes: { type: ['string', 'null'], maxLength: 2000 },
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
      const b = req.body as {
        items: Array<{ mode_id: number; paper_id: number; size_key: string; quantity: number }>
        email: string
        name: string
        contact_info?: string | null
        notes?: string | null
      }
      const orderId = createOrder(db, {
        customerId: GUEST_SENTINEL_ID,
        internal: false,
        items: b.items,
        contactInfo: b.contact_info ?? null,
        notes: b.notes ?? null,
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
                'ready',
                'delivered',
                'cancelled',
              ],
            },
          },
        },
        response: { 200: ORDER_LIST_SCHEMA },
      },
    },
    async (req) => {
      const user = req.user as NonNullable<typeof req.user>
      const { status } = req.query as { status?: string }
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
      const rows = db
        .prepare(
          `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY created_at DESC LIMIT 500`,
        )
        .all(...params) as OrderRow[]
      // owner 看自己的 token、admin 看全部——两类调用方都有资格拿 token
      return rows.map((o) => orderDto(db, o, currency, { admin, includeToken: true }))
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
              enum: ['confirmed', 'in_production', 'ready', 'delivered', 'cancelled'],
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
        if (status === 'delivered') {
          db.prepare("UPDATE orders SET status = 'delivered', completed_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            id,
          )
        } else {
          db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id)
        }
      }
      const updated = getOrder(db, id) as OrderRow
      const currency = baseCurrency(db)
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

  // ---------- 管理域: 收款 / 折扣（C7：整数减额，禁百分比） ----------

  app.patch(
    '/api/orders/:id/payment',
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
          required: ['payment_status'],
          additionalProperties: false,
          properties: {
            payment_status: { type: 'string', enum: ['unpaid', 'deposit', 'paid'] },
            paid_amount: { type: 'integer', minimum: 0 },
            payment_method: { type: ['string', 'null'], maxLength: 50 },
          },
        },
        response: { 200: ORDER_SCHEMA, 404: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const b = req.body as {
        payment_status: 'unpaid' | 'deposit' | 'paid'
        paid_amount?: number
        payment_method?: string | null
      }
      const order = getOrder(db, id)
      if (!order) return reply.status(404).send({ error: 'not_found' })
      // 目标 paid_amount 并做上限/一致性校验：钱不可超付，状态须与金额自洽
      const total = order.total
      const newPaid =
        b.payment_status === 'unpaid'
          ? 0
          : b.payment_status === 'paid'
            ? (b.paid_amount ?? total) // 标记结清而未给金额 → 默认等于 total
            : (b.paid_amount ?? order.paid_amount)
      if (newPaid > total) return reply.status(422).send({ error: 'paid_exceeds_total' })
      if (b.payment_status === 'paid' && newPaid !== total) {
        return reply.status(422).send({ error: 'paid_amount_must_equal_total' })
      }
      if (b.payment_status === 'deposit' && !(newPaid > 0 && newPaid < total)) {
        return reply.status(422).send({ error: 'deposit_out_of_range' })
      }
      const paidAt = b.payment_status === 'unpaid' ? null : (order.paid_at ?? new Date().toISOString())
      db.prepare(
        'UPDATE orders SET payment_status = ?, paid_amount = ?, payment_method = ?, paid_at = ? WHERE id = ?',
      ).run(
        b.payment_status,
        newPaid,
        'payment_method' in b ? (b.payment_method ?? null) : order.payment_method,
        paidAt,
        id,
      )
      const updated = getOrder(db, id) as OrderRow
      return orderDto(db, updated, baseCurrency(db), { admin: true, includeToken: true })
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
      if (discount > order.subtotal) {
        return reply.status(422).send({ error: 'discount_exceeds_subtotal' })
      }
      // total = subtotal − discount：整数减法，无舍入
      db.prepare('UPDATE orders SET discount = ?, total = subtotal - ? WHERE id = ?').run(discount, discount, id)
      const updated = getOrder(db, id) as OrderRow
      return orderDto(db, updated, baseCurrency(db), { admin: true, includeToken: true })
    },
  )
}
