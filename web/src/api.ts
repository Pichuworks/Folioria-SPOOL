export interface CurrencyDto {
  code: string
  symbol: string
  decimal_places: number
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
}

let meCache: MeDto | null | undefined = undefined
export const getMeCache = (): MeDto | null | undefined => meCache

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
  return meCache
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
  meCache = null
  dashboardCache = null
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  })
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
