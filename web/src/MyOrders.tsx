import { useEffect, useState } from 'react'
import { fetchOrders, type OrderDto } from './api'
import CustomerGate from './CustomerGate'
import { StatusBadge } from './OrderView'
import { Leader, MagSec, PillLink } from './spec'

function OrdersList() {
  const [orders, setOrders] = useState<OrderDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetchOrders().then((res) => {
      if (res.ok) setOrders(res.data)
      else setError(`订单加载失败（${res.status}）`)
    })
  }, [])

  if (error) return <p className="pt-13 text-[14px] text-wine-ink">{error}</p>
  if (!orders) return <p className="pt-13 text-[14px] text-dim">订单加载中…</p>

  return (
    <MagSec tag="订单" title="我的订单" note={`${orders.length} 单`}>
      {orders.length === 0 ? (
        <div>
          <p className="text-[14px] text-dim">还没有订单。</p>
          <div className="mt-4">
            <PillLink href="#/quote" kind="primary">去自助报价下单 →</PillLink>
          </div>
        </div>
      ) : (
        <div>
          {orders.map((o) => (
            <a
              key={o.id}
              href={`#/order/${o.access_token}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-[12px] hover:bg-card"
            >
              <span className="font-mono text-[13px] text-ink">{o.order_number}</span>
              <StatusBadge status={o.status} />
              {o.quote_expired && (
                <span className="font-mono text-[10px] tracking-[.1em] text-warn">报价过期</span>
              )}
              <span className="text-[12px] text-dim">
                {o.created_at.slice(0, 10)} · {o.items.length} 行
              </span>
              <Leader />
              <span className="font-mono text-[13.5px] text-wine-ink">{o.total_display}</span>
            </a>
          ))}
        </div>
      )}
    </MagSec>
  )
}

/** R8 #/my/orders：登录用户订单列表（CustomerGate：登录/注册门） */
export default function MyOrders() {
  return <CustomerGate>{() => <OrdersList />}</CustomerGate>
}
