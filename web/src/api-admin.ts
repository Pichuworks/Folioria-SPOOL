import { send, swr, type CacheEntry } from './api-core'
import { _setDashboardClearer } from './api-auth'

// ---------- Alerts / Notifications ----------

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
  const res = await send<{ data: AlertDto[]; total: number }>('GET', `/api/alerts${all ? '?all=1' : ''}`)
  return res.ok ? res.data.data : []
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

// ---------- Dashboard ----------

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

let dashboardEntry: CacheEntry<DashboardDto> | null = null
export const getDashboardCache = (): DashboardDto | null => dashboardEntry?.data ?? null

_setDashboardClearer({ clear: () => { dashboardEntry = null } })

export function fetchDashboard(): Promise<DashboardDto> {
  return swr(dashboardEntry, async () => {
    const res = await fetch('/api/dashboard')
    if (!res.ok) throw new Error(`dashboard failed: ${res.status}`)
    return (await res.json()) as DashboardDto
  }, (e) => { dashboardEntry = e })
}

// ---------- Announcements ----------

export interface AnnouncementDto {
  id: string
  title: string
  body: string
  audience: 'public' | 'all' | 'customers' | 'staff'
  pinned: boolean
  pin_sort: number
  published_at: string | null
  expires_at: string | null
  author_id: string
  author_name: string | null
  archived: boolean
  created_at: string
  updated_at: string
}

export interface PublicAnnouncementDto {
  id: string
  title: string
  body: string
  pinned: boolean
  pin_sort: number
  published_at: string
}

export interface UserAnnouncementDto {
  id: string
  title: string
  body: string
  audience: string
  pinned: boolean
  pin_sort: number
  published_at: string
  read: boolean
}

export async function fetchPublicAnnouncements(): Promise<PublicAnnouncementDto[]> {
  const res = await fetch('/api/public-announcements')
  if (!res.ok) return []
  return (await res.json()) as PublicAnnouncementDto[]
}

export async function fetchUserAnnouncements(): Promise<UserAnnouncementDto[]> {
  const res = await send<UserAnnouncementDto[]>('GET', '/api/announcements')
  return res.ok ? res.data : []
}

export async function fetchUnreadCount(): Promise<number> {
  const res = await send<{ count: number }>('GET', '/api/announcements/unread-count')
  return res.ok ? res.data.count : 0
}

export const markAnnouncementRead = (id: string) =>
  send('POST', `/api/announcements/${id}/read`)

export const fetchAdminAnnouncements = () =>
  send<AnnouncementDto[]>('GET', '/api/admin/announcements')

export const createAnnouncement = (body: {
  title: string
  body?: string
  audience?: string
  pinned?: boolean
  pin_sort?: number
  expires_at?: string | null
  publish?: boolean
}) => send<AnnouncementDto>('POST', '/api/admin/announcements', body)

export const updateAnnouncement = (id: string, body: Record<string, unknown>) =>
  send<AnnouncementDto>('PATCH', `/api/admin/announcements/${id}`, body)

export const archiveAnnouncement = (id: string) =>
  send('PATCH', `/api/admin/announcements/${id}/archive`)
