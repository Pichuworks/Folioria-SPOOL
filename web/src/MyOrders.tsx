import { useEffect } from 'react'

export default function MyOrders() {
  useEffect(() => {
    window.location.replace('#/dashboard')
  }, [])
  return <p className="pt-13 text-[14px] text-dim">跳转中…</p>
}
