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

export interface MeDto {
  id: string
  email: string
  name: string
  role: 'customer' | 'member' | 'admin'
  must_change_password: boolean
  email_verified: boolean
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
}

let publicConfigCache: PublicConfigDto | undefined
export const getPublicConfigCache = (): PublicConfigDto | undefined => publicConfigCache

export async function fetchPublicConfig(): Promise<PublicConfigDto> {
  const res = await fetch('/api/public-config')
  if (!res.ok) throw new Error(`public-config failed: ${res.status}`)
  publicConfigCache = (await res.json()) as PublicConfigDto
  return publicConfigCache
}

export async function fetchMe(): Promise<MeDto | null> {
  const res = await fetch('/api/auth/me')
  if (res.status === 401) return (meCache = null)
  if (!res.ok) throw new Error(`me failed: ${res.status}`)
  meCache = (await res.json()) as MeDto
  return meCache
}

export async function login(email: string, password: string): Promise<MeDto | null> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
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

export interface OrderItemDto {
  id: string
  mode_id: number
  mode_name: string
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
  job_id?: string | null | undefined
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
  subtotal: number
  subtotal_display: string
  discount: number
  discount_display: string
  total: number
  total_display: string
  payment_status: 'unpaid' | 'deposit' | 'paid'
  paid_amount: number
  paid_amount_display: string
  payment_method: string | null
  paid_at: string | null
  quote_valid_until: string
  quote_expired: boolean
  created_at: string
  confirmed_at: string | null
  completed_at: string | null
  notes: string | null
  items: OrderItemDto[]
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

export const createOrder = (body: {
  items: Array<{ mode_id: number; paper_id: number; size_key: string; quantity: number }>
  contact_info?: string | null
  notes?: string | null
}) => send<OrderDto & { error?: string }>('POST', '/api/orders', body)

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

export const patchOrderPayment = (
  id: string,
  body: { payment_status: 'unpaid' | 'deposit' | 'paid'; paid_amount?: number; payment_method?: string | null },
) => send<OrderDto>('PATCH', `/api/orders/${id}/payment`, body)

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
