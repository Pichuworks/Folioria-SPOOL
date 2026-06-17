import { useEffect } from 'react'
import { useAuth } from './AuthContext'
import CustomerGate from './CustomerGate'

function RedirectAfterLogin() {
  const me = useAuth()
  useEffect(() => {
    window.location.replace(me?.role === 'admin' ? '#/dashboard' : '#/my/orders')
  }, [me])
  return <p className="pt-13 text-[14px] text-dim">登录成功，跳转中…</p>
}

export default function Login() {
  return <CustomerGate>{() => <RedirectAfterLogin />}</CustomerGate>
}
