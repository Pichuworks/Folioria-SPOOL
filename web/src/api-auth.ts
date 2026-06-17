import { send } from './api-core'

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

/** 登录态变化广播：App 导航条三态（guest/下单用户/admin）即时切换 */
export const AUTH_EVENT = 'spool-auth-changed'
export const fireAuthChanged = () => window.dispatchEvent(new Event(AUTH_EVENT))

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

export async function fetchMe(): Promise<MeDto | null> {
  const res = await fetch('/api/auth/me')
  if (res.status === 401) return (meCache = null)
  if (!res.ok) throw new Error(`me failed: ${res.status}`)
  meCache = (await res.json()) as MeDto
  return meCache
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

/** identifier = 用户名或邮箱（D18） */
export async function login(identifier: string, password: string): Promise<MeDto | null> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
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
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
    body: JSON.stringify({ token }),
  })
  if (res.ok && meCache) {
    meCache = { ...meCache, email_verified: true }
    fireAuthChanged()
  }
  return res.ok
}

let dashboardEntryRef: { clear: () => void } | null = null
export const _setDashboardClearer = (clearer: { clear: () => void }) => { dashboardEntryRef = clearer }

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-spool-request': '1' } })
  meCache = null
  dashboardEntryRef?.clear()
  fireAuthChanged()
}

/** D19: 请求重置——无论账号是否存在都 204，前台一律提示「若存在已发送」 */
export async function forgotPassword(identifier: string): Promise<void> {
  await fetch('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
    body: JSON.stringify({ identifier }),
  })
}

/** D19: 用 token 设新密码；成功 204 → true，无效/过期 404 → false */
export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const res = await fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
    body: JSON.stringify({ token, new_password: newPassword }),
  })
  return res.ok
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  })
  if (res.ok && meCache) {
    meCache = { ...meCache, must_change_password: false }
    fireAuthChanged()
  }
  return res.ok
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
