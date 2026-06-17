import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { AUTH_EVENT, fetchMe, getMeCache, type MeDto } from './api'

const AuthCtx = createContext<MeDto | null | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)

  useEffect(() => {
    let cancelled = false
    fetchMe().then((m) => { if (!cancelled) setMe(m) }).catch(() => { if (!cancelled) setMe(null) })
    const onAuth = () => { if (!cancelled) setMe(getMeCache() ?? null) }
    window.addEventListener(AUTH_EVENT, onAuth)
    return () => { cancelled = true; window.removeEventListener(AUTH_EVENT, onAuth) }
  }, [])

  return <AuthCtx.Provider value={me}>{children}</AuthCtx.Provider>
}

export const useAuth = (): MeDto | null | undefined => useContext(AuthCtx)
