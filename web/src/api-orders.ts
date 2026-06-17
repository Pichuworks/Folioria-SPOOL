import { send, type CurrencyDto } from './api-core'

// D35 文件预检（advisory；两域售价侧）
export interface FilePrecheckDto {
  level: 'ok' | 'info' | 'warn'
  items: Array<{ key: string; level: 'ok' | 'info' | 'warn'; message: string }>
}

export interface OrderItemFinishingDto {
  finishing_id: number
  name: string
  pricing: string
  price_c: number
  price_display: string
  contribution_c: number
  contribution_display: string
}

export interface OrderItemDto {
  id: string
  mode_id: number
  mode_name?: string
  category: string
  tech: string
  duplex: boolean
  paper_id: number
  paper_name: string
  size_key: string
  size_label: string
  quantity: number
  unit_price_c: number
  unit_display: string
  line_total: number
  line_total_display: string
  has_file: boolean
  file_status: 'pending' | 'approved' | 'rejected'
  file_note: string | null
  file_precheck?: FilePrecheckDto | null
  finishings: OrderItemFinishingDto[]
  job_id?: string | null | undefined
  file_kind?: string | undefined
}

// D27 订单内书行
export interface OrderBookComponentDto {
  id: string
  role: string
  paper_id: number
  paper_name: string
  size_key: string
  size_label: string
  color_class: string
  duplex: boolean
  sheets_per_book: number
  unit_sell_c: number
  unit_display: string
  has_file: boolean
  file_status: 'pending' | 'approved' | 'rejected'
  file_note: string | null
  file_precheck?: FilePrecheckDto | null
  source_component_id: number | null
  mode_id?: number
  job_id?: string | null
  file_kind?: string | undefined
}
export interface OrderBookFinishingDto {
  finishing_id: number
  name: string
  pricing: string
  price_c: number
  price_display: string
  contribution_c: number
  contribution_display: string
}
export interface OrderBookDto {
  id: string
  book_id: number | null
  name: string
  count: number
  unit_price_c: number
  unit_display: string
  line_total: number
  line_total_display: string
  components: OrderBookComponentDto[]
  finishings: OrderBookFinishingDto[]
}

// D28 收款流水
export interface PaymentDto {
  id: string
  kind: 'deposit' | 'balance' | 'refund'
  amount: number
  amount_display: string
  method: string | null
  note: string | null
  created_at: string
}

export interface OrderDto {
  id: string
  order_number: string
  access_token?: string | undefined
  status:
    | 'quoted'
    | 'file_pending'
    | 'file_approved'
    | 'confirmed'
    | 'in_production'
    | 'printed'
    | 'ready'
    | 'delivered'
    | 'cancelled'
  contact_info: string | null
  delivery_method?: 'pickup' | 'shipping' | string
  delivery_address?: string | null
  subtotal: number
  subtotal_display: string
  discount: number
  discount_display: string
  total: number
  total_display: string
  payment_status: 'unpaid' | 'deposit' | 'paid'
  paid_amount: number
  paid_amount_display: string
  refund_due?: number | undefined
  refund_due_display?: string | undefined
  payment_method: string | null
  paid_at: string | null
  quote_valid_until: string
  quote_expired: boolean
  created_at: string
  confirmed_at: string | null
  completed_at: string | null
  due_date?: string | null
  notes: string | null
  items: OrderItemDto[]
  books?: OrderBookDto[] | undefined
  payments?: PaymentDto[] | undefined
  is_guest?: boolean | undefined
  is_internal?: boolean | undefined
  customer?: { id: string; name: string; email: string; role: string } | undefined
}

export const ORDER_STATUS_LABEL: Record<OrderDto['status'], string> = {
  quoted: '报价中',
  file_pending: '待审稿',
  file_approved: '审稿通过',
  confirmed: '已确认',
  in_production: '生产中',
  printed: '已印完',
  ready: '待取件',
  delivered: '已交付',
  cancelled: '已取消',
}

export interface OrderLineBody {
  items?: Array<{ mode_id: number; paper_id: number; size_key: string; quantity: number; finishing_ids?: number[] }>
  custom_books?: Array<{
    count: number
    size_key: string
    components: Array<{
      role: 'cover' | 'inner' | 'insert'
      paper_id: number
      color_class: string
      duplex: number
      sheets_per_book: number
    }>
    finishing_ids?: number[]
  }>
}

/** D30 配送 */
export interface DeliveryBody {
  delivery_method?: 'pickup' | 'shipping'
  delivery_address?: string | null
}

export const createOrder = (
  body: OrderLineBody & DeliveryBody & { contact_info?: string | null; notes?: string | null },
) => send<OrderDto & { error?: string }>('POST', '/api/orders', body)

/** D23 免登录下单（需 guest_orders_open）；返回订单含 access_token */
export const createGuestOrder = (
  body: OrderLineBody & DeliveryBody & { email: string; name: string; contact_info?: string | null; notes?: string | null },
) => send<OrderDto & { error?: string }>('POST', '/api/orders/guest', body)

/** D23 已验证用户认领访客单 */
export const claimOrder = (token: string) =>
  send<OrderDto & { error?: string }>('POST', `/api/orders/by-token/${encodeURIComponent(token)}/claim`)

export async function fetchOrders(status?: string) {
  const res = await send<{ data: OrderDto[]; total: number }>('GET', `/api/orders${status ? `?status=${status}` : ''}`)
  if (!res.ok) return { ok: false as const, status: res.status, data: [] as OrderDto[] }
  return { ok: true as const, status: res.status, data: res.data.data }
}

export const fetchOrderByToken = (token: string) =>
  send<OrderDto>('GET', `/api/orders/by-token/${encodeURIComponent(token)}`)

export const patchOrderStatus = (id: string, status: string) =>
  send<OrderDto & { error?: string }>('PATCH', `/api/orders/${id}/status`, { status })

export const reviewOrderItem = (orderId: string, itemId: string, verdict: 'approved' | 'rejected', note?: string) =>
  send<OrderDto>('PATCH', `/api/orders/${orderId}/items/${itemId}/file-review`, {
    file_status: verdict,
    file_note: note ?? null,
  })

// D31 书组件文件审稿
export const reviewOrderBookComponent = (
  orderId: string,
  compId: string,
  verdict: 'approved' | 'rejected',
  note?: string,
) =>
  send<OrderDto>('PATCH', `/api/orders/${orderId}/book-components/${compId}/file-review`, {
    file_status: verdict,
    file_note: note ?? null,
  })

/** 追加一笔流水（押金/尾款/退款）。amount 带符号：收正、退负 */
export const recordPayment = (
  id: string,
  body: { kind: 'deposit' | 'balance' | 'refund'; amount: number; method?: string | null; note?: string | null },
) => send<OrderDto & { error?: string }>('POST', `/api/orders/${id}/payments`, body)

export const patchOrderDiscount = (id: string, discount: number) =>
  send<OrderDto & { error?: string }>('PATCH', `/api/orders/${id}/discount`, { discount })

export async function uploadOrderItemFile(
  orderId: string,
  itemId: string,
  file: File,
): Promise<{ ok: boolean; status: number; data: OrderDto | { error?: string } }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`/api/orders/${orderId}/items/${itemId}/file`, { method: 'POST', headers: { 'x-spool-request': '1' }, body: form })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // 无 body
  }
  return { ok: res.ok, status: res.status, data: data as OrderDto | { error?: string } }
}

export const orderItemFileUrl = (orderId: string, itemId: string): string =>
  `/api/orders/${orderId}/items/${itemId}/file`

export async function uploadOrderBookComponentFile(
  orderId: string,
  compId: string,
  file: File,
): Promise<{ ok: boolean; status: number; data: OrderDto | { error?: string } }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`/api/orders/${orderId}/book-components/${compId}/file`, { method: 'POST', headers: { 'x-spool-request': '1' }, body: form })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // 无 body
  }
  return { ok: res.ok, status: res.status, data: data as OrderDto | { error?: string } }
}

export const orderBookComponentFileUrl = (orderId: string, compId: string): string =>
  `/api/orders/${orderId}/book-components/${compId}/file`

// C1 一键再下单：跨视图传递预填行
export interface ReorderItem {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  label: string
}
export interface ReorderBook {
  count: number
  size_key: string
  components: Array<{
    role: 'cover' | 'inner' | 'insert'
    paper_id: number
    color_class: string
    duplex: number
    sheets_per_book: number
  }>
  finishing_ids: number[]
  label: string
}
export interface ReorderBuffer {
  items: ReorderItem[]
  books: ReorderBook[]
}
let reorderBuffer: ReorderBuffer | null = null
export const setReorder = (buf: ReorderBuffer): void => {
  reorderBuffer = buf
}
/** 取出并清空缓冲（Quote 挂载时消费一次） */
export const takeReorder = (): ReorderBuffer | null => {
  const b = reorderBuffer
  reorderBuffer = null
  return b
}
