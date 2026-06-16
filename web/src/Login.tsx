import { useEffect } from 'react'
import { getMeCache } from './api'
import CustomerGate from './CustomerGate'

function RedirectAfterLogin() {
  useEffect(() => {
    const me = getMeCache()
    window.location.replace(me?.role === 'admin' ? '#/dashboard' : '#/my/orders')
  }, [])
  return <p className="pt-13 text-[14px] text-dim">登录成功，跳转中…</p>
}

export default function Login() {
  return <CustomerGate>{() => <RedirectAfterLogin />}</CustomerGate>
}
