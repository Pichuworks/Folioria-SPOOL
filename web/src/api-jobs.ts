import { send } from './api-core'

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
  order_book_id?: string | null
  book_name?: string | null
  book_role?: string | null
}

let jobsCache: JobDto[] | null = null
export const getJobsCache = (): JobDto[] | null => jobsCache

export async function fetchJobs(): Promise<JobDto[]> {
  const res = await fetch('/api/jobs')
  if (!res.ok) throw new Error(`jobs failed: ${res.status}`)
  const body = (await res.json()) as { data: JobDto[]; total: number }
  jobsCache = body.data
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
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
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
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/jobs/${id}/done`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
    body: JSON.stringify(body),
  })
  if (res.ok) return { ok: true }
  const data = await res.json().catch(() => null)
  return { ok: false, error: (data as { error?: string } | null)?.error ?? 'unknown' }
}

/** Board → Jobs 穿透：临时存储待高亮的 job ID */
let _highlightJobId: string | null = null
export function setHighlightJobId(id: string) { _highlightJobId = id }
export function consumeHighlightJobId() { const id = _highlightJobId; _highlightJobId = null; return id }
