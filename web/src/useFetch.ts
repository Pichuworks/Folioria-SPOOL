import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Generic data-fetching hook.  Encapsulates the useState+useEffect pattern
 * repeated across admin pages.
 *
 * The abort signal is used to suppress setState after unmount -- it does NOT
 * cancel the underlying fetch (callers rarely pass AbortSignal today).
 */
export function useFetch<T>(fn: () => Promise<T>): {
  data: T | null
  loading: boolean
  error: boolean
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const load = useCallback(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    fnRef.current()
      .then((result) => {
        if (!controller.signal.aborted) setData(result)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return controller
  }, [])

  useEffect(() => {
    const controller = load()
    return () => controller.abort()
  }, [load])

  const reload = useCallback(() => { load() }, [load])

  return { data, loading, error, reload }
}
