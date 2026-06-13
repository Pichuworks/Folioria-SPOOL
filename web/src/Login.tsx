import { useEffect } from 'react'
import CustomerGate from './CustomerGate'

/** #/login：复用下单域统一门；登录/注册成功后回我的订单 */
function RedirectToOrders() {
  useEffect(() => {
    window.location.replace('#/my/orders')
  }, [])
  return <p className="pt-13 text-[14px] text-dim">登录成功，跳转中…</p>
}

export default function Login() {
  return <CustomerGate>{() => <RedirectToOrders />}</CustomerGate>
}
