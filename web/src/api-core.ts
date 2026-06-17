import { startLoading, stopLoading } from './spec'

export interface CurrencyDto {
  code: string
  symbol: string
  decimal_places: number
}

export interface PriceEntryDto {
  sell_c: number
  display: string
}

/** 管理域 CRUD 通用通道：ok=false 时 data 形如 { error } */
export async function send<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  startLoading()
  try {
    const init: RequestInit = { method }
    const headers: Record<string, string> = { 'x-spool-request': '1' }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    init.headers = headers
    const res = await fetch(url, init)
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      // 204 等无 body 响应
    }
    return { ok: res.ok, status: res.status, data: data as T }
  } catch {
    return { ok: false, status: 0, data: { error: 'network_error' } as T }
  } finally {
    stopLoading()
  }
}

// ---------- SWR cache utility ----------

const CACHE_TTL = 60_000

export interface CacheEntry<T> { data: T; at: number }

export function swr<T>(entry: CacheEntry<T> | null, fetchFn: () => Promise<T>, setEntry: (e: CacheEntry<T>) => void): Promise<T> {
  const fresh = async () => { const d = await fetchFn(); setEntry({ data: d, at: Date.now() }); return d }
  if (!entry) return fresh()
  if (Date.now() - entry.at < CACHE_TTL) return Promise.resolve(entry.data)
  void fresh()
  return Promise.resolve(entry.data)
}
