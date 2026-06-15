export interface CurrencyDto {
  code: string
  symbol: string
  decimal_places: number
}

/** 管理域 CRUD 通用通道：ok=false 时 data 形如 { error } */
export async function send<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // 204 等无 body 响应
  }
  return { ok: res.ok, status: res.status, data: data as T }
}

export interface PriceEntryDto {
  sell_c: number
  display: string
}

// ---------- 报警收件箱 / 通知日志（管理域运维可见性，Tier 0）----------

export interface AlertDto {
  id: string
  type: string
  severity: 'info' | 'warning' | 'critical'
  target_type: string
  target_id: string
  message: string
  acknowledged: number
  acknowledged_by: string | null
  created_at: string
  resolved_at: string | null
}

export async function fetchAlerts(all = false): Promise<AlertDto[]> {
  const res = await send<AlertDto[]>('GET', `/api/alerts${all ? '?all=1' : ''}`)
  return res.ok ? res.data : []
}
export const acknowledgeAlert = async (id: string): Promise<boolean> =>
  (await send('PATCH', `/api/alerts/${id}/acknowledge`)).ok
export const resolveAlertReq = async (id: string): Promise<boolean> =>
  (await send('PATCH', `/api/alerts/${id}/resolve`)).ok

export interface ScanResult {
  low_stock: number
  consumable_low: number
  calibration_due: number
}
export async function scanAlerts(): Promise<ScanResult | null> {
  const res = await send<ScanResult>('POST', '/api/alerts/scan', {})
  return res.ok ? res.data : null
}

export interface NotificationLogDto {
  id: string
  event: string
  channel: string
  recipient: string
  status: 'sent' | 'failed' | 'skipped'
  error: string | null
  sent_at: string
}
export async function fetchNotifications(): Promise<NotificationLogDto[]> {
  const res = await send<NotificationLogDto[]>('GET', '/api/notifications')
  return res.ok ? res.data : []
}

export interface OptionsDto {
  currency: CurrencyDto
  sizes: Array<{ key: string; label: string; sort: number }>
  modes: Array<{ id: number; name: string; duplex: boolean; max_size: string }>
  papers: Array<{ id: number; name: string }>
  options: Array<{ mode_id: number; paper_id: number; prices: Record<string, PriceEntryDto> }>
}

export interface QuoteDto {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  unit_price_c: number
  unit_display: string
  line_total: number
  line_total_display: string
  currency: string
}

// 模块级缓存：hash 路由切换会重挂载视图，缓存让二次进入即时渲染（后台再刷新）
let optionsCache: OptionsDto | null = null
export const getOptionsCache = (): OptionsDto | null => optionsCache

export async function fetchOptions(): Promise<OptionsDto> {
  const res = await fetch('/api/calculator/options')
  if (!res.ok) throw new Error(`options failed: ${res.status}`)
  optionsCache = (await res.json()) as OptionsDto
  return optionsCache
}

// ③⑤ 客户产品视图：按属性折叠的目录（机器不可见）
export interface ProductDto {
  category: string
  tech: string
  paper_id: number
  size_key: string
  duplex: boolean
  mode_id: number
  sell_c: number
  display: string
}
export interface ProductsDto {
  currency: CurrencyDto
  papers: Array<{ id: number; name: string }>
  sizes: Array<{ key: string; label: string; sort: number }>
  products: ProductDto[]
}
let productsCache: ProductsDto | null = null
export const getProductsCache = (): ProductsDto | null => productsCache
export async function fetchProducts(): Promise<ProductsDto> {
  const res = await fetch('/api/calculator/products')
  if (!res.ok) throw new Error(`products failed: ${res.status}`)
  productsCache = (await res.json()) as ProductsDto
  return productsCache
}

// ③⑤/D27 册子目录（机器对客户不可见）
export interface BookComponentDto {
  id: number
  role: 'cover' | 'inner' | 'insert'
  paper_id: number
  paper_name: string
  size_key: string
  size_label: string
  color_class: string
  duplex: boolean
}
export interface BookFinishingDto {
  id: number
  name: string
  pricing: 'per_book' | 'per_page' | 'per_area'
  price_c: number
  price_display: string
}
export interface BookCatalogItemDto {
  id: number
  name: string
  components: BookComponentDto[]
  finishings: BookFinishingDto[]
}
export interface BooksCatalogDto {
  currency: CurrencyDto
  books: BookCatalogItemDto[]
}
let booksCache: BooksCatalogDto | null = null
export const getBooksCache = (): BooksCatalogDto | null => booksCache
export async function fetchBooks(): Promise<BooksCatalogDto> {
  const res = await fetch('/api/calculator/books')
  if (!res.ok) throw new Error(`books failed: ${res.status}`)
  booksCache = (await res.json()) as BooksCatalogDto
  return booksCache
}

export interface BookQuoteDto {
  book_id: number
  name: string
  count: number
  unit_price_c: number
  unit_display: string
  line_total: number
  line_total_display: string
  components: Array<{ component_id: number; role: string; sheets_per_book: number; unit_sell_c: number; unit_display: string }>
  finishings: Array<{ finishing_id: number; name: string; pricing: string; contribution_c: number; contribution_display: string }>
}
/** 册子实时报价：客户填内页/插图张数 + 本数 → 出价（机器不可见）。422 → { error } */
export const fetchBookQuote = (body: {
  book_id: number
  count: number
  components?: Array<{ component_id: number; sheets_per_book: number }>
}) => send<BookQuoteDto & { error?: string }>('POST', '/api/calculator/book-quote', body)

export interface MeDto {
  id: string
  email: string
  username: string | null
  name: string
  contact_info: string | null
  role: 'customer' | 'member' | 'admin'
  must_change_password: boolean
  email_verified: boolean
}

/** 下单域账号资料编辑（称呼 / 联系方式）；成功刷新 me 缓存并广播 */
export async function updateProfile(body: { name?: string; contact_info?: string | null }): Promise<MeDto | null> {
  const res = await send<MeDto>('PATCH', '/api/auth/profile', body)
  if (res.ok) {
    meCache = res.data
    fireAuthChanged()
  }
  return res.ok ? res.data : null
}

/** 登录态变化广播：App 导航条三态（guest/下单用户/admin）即时切换 */
export const AUTH_EVENT = 'spool-auth-changed'
const fireAuthChanged = () => window.dispatchEvent(new Event(AUTH_EVENT))

let meCache: MeDto | null | undefined = undefined
export const getMeCache = (): MeDto | null | undefined => meCache

export interface PublicConfigDto {
  initialized: boolean
  require_email_verification: boolean
  registration_open: boolean
  guest_orders_open: boolean
}

let publicConfigCache: PublicConfigDto | undefined
export const getPublicConfigCache = (): PublicConfigDto | undefined => publicConfigCache

export async function fetchPublicConfig(): Promise<PublicConfigDto> {
  const res = await fetch('/api/public-config')
  if (!res.ok) throw new Error(`public-config failed: ${res.status}`)
  publicConfigCache = (await res.json()) as PublicConfigDto
  return publicConfigCache
}

// C3 通知偏好（仅 email channel）
export interface NotifyPrefsDto {
  channels: string[]
  addresses: { email?: string }
  account_email: string
}
export const fetchNotifyPrefs = () => send<NotifyPrefsDto>('GET', '/api/auth/notify-prefs')
export const updateNotifyPrefs = (body: { channels?: string[]; addresses?: { email?: string | null } }) =>
  send<NotifyPrefsDto & { error?: string }>('PATCH', '/api/auth/notify-prefs', body)

export async function fetchMe(): Promise<MeDto | null> {
  const res = await fetch('/api/auth/me')
  if (res.status === 401) return (meCache = null)
  if (!res.ok) throw new Error(`me failed: ${res.status}`)
  meCache = (await res.json()) as MeDto
  return meCache
}

/** identifier = 用户名或邮箱（D18） */
export async function login(identifier: string, password: string): Promise<MeDto | null> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  meCache = (await res.json()) as MeDto
  fireAuthChanged()
  return meCache
}

/** R4 下单域注册：成功即登录；403=注册关闭/邀请码错，409=邮箱已注册 */
export async function register(body: {
  email: string
  username?: string
  name: string
  password: string
  invite_code?: string
}): Promise<{ me: MeDto | null; error: string | null }> {
  const res = await send<MeDto & { error?: string }>('POST', '/api/auth/register', body)
  if (!res.ok) return { me: null, error: (res.data as { error?: string })?.error ?? `http_${res.status}` }
  meCache = res.data
  fireAuthChanged()
  return { me: res.data, error: null }
}

/** 首次运行向导：初始化实例并自动登录为首位 admin */
export async function setupInstance(body: {
  base_currency: string
  admin_email: string
  admin_name: string
  admin_password: string
  seed?: boolean
}): Promise<{ me: MeDto | null; error: string | null }> {
  const res = await send<MeDto & { error?: string }>('POST', '/api/setup', body)
  if (!res.ok) return { me: null, error: (res.data as { error?: string })?.error ?? `http_${res.status}` }
  meCache = res.data
  if (publicConfigCache) publicConfigCache = { ...publicConfigCache, initialized: true }
  fireAuthChanged()
  return { me: res.data, error: null }
}

export async function verifyEmailToken(token: string): Promise<boolean> {
  const res = await fetch('/api/auth/verify-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (res.ok && meCache) meCache = { ...meCache, email_verified: true }
  return res.ok
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
  meCache = null
  dashboardCache = null
  fireAuthChanged()
}

/** D19: 请求重置——无论账号是否存在都 204，前台一律提示「若存在已发送」 */
export async function forgotPassword(identifier: string): Promise<void> {
  await fetch('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  })
}

/** D19: 用 token 设新密码；成功 204 → true，无效/过期 404 → false */
export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const res = await fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, new_password: newPassword }),
  })
  return res.ok
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  })
  // 改密成功即清首登标志，广播让导航三态/门即时解锁（D11）
  if (res.ok && meCache) {
    meCache = { ...meCache, must_change_password: false }
    fireAuthChanged()
  }
  return res.ok
}

export interface DashboardDto {
  todo: { jobs_active: number; orders_active: number; maintenance_alerts: number }
  inventory_alerts: Array<{ id: string; type: string; severity: string; message: string }>
  monthly: {
    jobs_done: number
    revenue: number
    external_cost: number
    internal_cost: number
    profit: number
    pages: number
    revenue_display: string
    external_cost_display: string
    internal_cost_display: string
    profit_display: string
  }
  equipment: Array<{
    code: string
    name: string
    status: string
    total_pages: number
    calibration_due: boolean
  }>
}

let dashboardCache: DashboardDto | null = null
export const getDashboardCache = (): DashboardDto | null => dashboardCache

export async function fetchDashboard(): Promise<DashboardDto> {
  const res = await fetch('/api/dashboard')
  if (!res.ok) throw new Error(`dashboard failed: ${res.status}`)
  dashboardCache = (await res.json()) as DashboardDto
  return dashboardCache
}

export interface JobDto {
  id: string
  title: string
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  waste_quantity: number
  pages_consumed: number | null
  status: 'draft' | 'queued' | 'printing' | 'done' | 'cancelled'
  quoted_price: number | null
  total_cost: number | null
  profit: number | null
  created_at: string
  completed_at: string | null
  notes: string | null
  mode_name: string
  paper_name: string
  total_cost_display: string | null
  profit_display: string | null
  quoted_price_display: string | null
  // D27/PB3 书行组件作业编组（item 作业为 null）
  order_book_id?: string | null
  book_name?: string | null
  book_role?: string | null
}

let jobsCache: JobDto[] | null = null
export const getJobsCache = (): JobDto[] | null => jobsCache

export async function fetchJobs(): Promise<JobDto[]> {
  const res = await fetch('/api/jobs')
  if (!res.ok) throw new Error(`jobs failed: ${res.status}`)
  jobsCache = (await res.json()) as JobDto[]
  return jobsCache
}

export interface JobPreviewDto {
  ink_c: number
  paper_c: number
  overhead_c: number
  unit_total_c: number
  ink_display: string
  paper_display: string
  overhead_display: string
  unit_total_display: string
  est_total: number | null
  est_total_display: string | null
  on_hand: number
  reserved: number
  available: number
}

export async function fetchJobPreview(req: {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
}): Promise<JobPreviewDto | null> {
  const qs = new URLSearchParams({
    mode_id: String(req.mode_id),
    paper_id: String(req.paper_id),
    size_key: req.size_key,
    quantity: String(req.quantity),
  })
  const res = await fetch(`/api/jobs/preview?${qs}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`preview failed: ${res.status}`)
  return (await res.json()) as JobPreviewDto
}

export async function createJob(body: {
  title: string
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  quoted_price?: number | null
}): Promise<(JobDto & { availability_warning: boolean }) | null> {
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return null
  return (await res.json()) as JobDto & { availability_warning: boolean }
}

export async function patchJobStatus(
  id: string,
  status: 'queued' | 'printing' | 'cancelled',
): Promise<boolean> {
  const res = await fetch(`/api/jobs/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  return res.ok
}

export interface MachineRecDto {
  mode_id: number
  mode_name: string
  printer_id: number
  printer_code: string
  printer_status: string
  unit_cost_c: number
  queue_pages: number
  unit_cost_display: string
}

/** ③⑤ 机器推荐：能做该 纸×尺寸 的机台按 在线→成本→负载 排序 */
export async function fetchJobRecommend(paperId: number, sizeKey: string): Promise<MachineRecDto[]> {
  const res = await send<MachineRecDto[]>(
    'GET',
    `/api/jobs/recommend?paper_id=${paperId}&size_key=${encodeURIComponent(sizeKey)}`,
  )
  return res.ok ? res.data : []
}

/** ③⑤ 改派作业机台 */
export const reassignJobMode = async (id: string, modeId: number): Promise<boolean> =>
  (await send('PATCH', `/api/jobs/${id}/mode`, { mode_id: modeId })).ok

export async function completeJob(
  id: string,
  body: { waste_quantity: number; pages_consumed?: number },
): Promise<boolean> {
  const res = await fetch(`/api/jobs/${id}/done`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.ok
}

// ---------- 订单（R1–R6/R8） ----------

// D35 文件预检（advisory；两域售价侧）
export interface FilePrecheckDto {
  level: 'ok' | 'info' | 'warn'
  items: Array<{ key: string; level: 'ok' | 'info' | 'warn'; message: string }>
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
  job_id?: string | null | undefined
}

// D27 订单内书行（下单域：仅售价侧；mode_id/job_id 仅 admin 视图）
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
  book_id: number
  name: string
  count: number
  unit_price_c: number
  unit_display: string
  line_total: number
  line_total_display: string
  components: OrderBookComponentDto[]
  finishings: OrderBookFinishingDto[]
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
  refund_due?: number | undefined // PC2: 已取消且已收款的须退额（admin 视图）
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
  ready: '待取件',
  delivered: '已交付',
  cancelled: '已取消',
}

/** D27: items 与 books 均可选，至少一行 */
export interface OrderLineBody {
  items?: Array<{ mode_id: number; paper_id: number; size_key: string; quantity: number }>
  books?: Array<{ book_id: number; count: number; components?: Array<{ component_id: number; sheets_per_book: number }> }>
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

export const fetchOrders = (status?: string) =>
  send<OrderDto[]>('GET', `/api/orders${status ? `?status=${status}` : ''}`)

export const fetchOrderByToken = (token: string) =>
  send<OrderDto>('GET', `/api/orders/by-token/${encodeURIComponent(token)}`)

export const patchOrderStatus = (id: string, status: string) =>
  send<OrderDto & { error?: string }>('PATCH', `/api/orders/${id}/status`, { status })

export const reviewOrderItem = (orderId: string, itemId: string, verdict: 'approved' | 'rejected', note?: string) =>
  send<OrderDto>('PATCH', `/api/orders/${orderId}/items/${itemId}/file-review`, {
    file_status: verdict,
    file_note: note ?? null,
  })

// D31 书组件文件上传/审稿（与单页 item 同口径）
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

// D28 收款流水（append-only；paid_amount/payment_status 为其投影）
export interface PaymentDto {
  id: string
  kind: 'deposit' | 'balance' | 'refund'
  amount: number
  amount_display: string
  method: string | null
  note: string | null
  created_at: string
}

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
  const res = await fetch(`/api/orders/${orderId}/items/${itemId}/file`, { method: 'POST', body: form })
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
  const res = await fetch(`/api/orders/${orderId}/book-components/${compId}/file`, { method: 'POST', body: form })
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

// C1 一键再下单：跨视图传递预填行（module 级缓冲，hash 切换不重载）。D32 含册子行
export interface ReorderItem {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  label: string
}
/** D32 册子行预填：book_id + 本数 + 各非封面组件（source_component_id → 每本张数） */
export interface ReorderBook {
  book_id: number
  count: number
  components: Array<{ component_id: number; sheets_per_book: number }>
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

export async function fetchQuote(req: {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
}): Promise<QuoteDto | null> {
  const res = await fetch('/api/calculator/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`quote failed: ${res.status}`)
  return (await res.json()) as QuoteDto
}
