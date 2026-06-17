import { lazy, Suspense, useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import CustomerGate from './CustomerGate'
import {
  fetchDashboard,
  fetchMe,
  fetchOrders,
  getDashboardCache,
  getMeCache,
  ORDER_STATUS_LABEL,
  send,
  type DashboardDto,
  type MeDto,
  type OrderDto,
} from './api'
import type { TrendPoint } from './DashboardCharts'
import { StatusBadge } from './OrderView'
import { Leader, MagSec, PillLink, Skeleton, SpecRow } from './spec'

const TrendChart = lazy(() => import('./DashboardCharts').then((m) => ({ default: m.TrendChart })))
const EquipmentChart = lazy(() => import('./DashboardCharts').then((m) => ({ default: m.EquipmentChart })))

/* ── Admin Dashboard (existing) ── */

function AdminDashboardBody() {
  const [data, setData] = useState<DashboardDto | null>(getDashboardCache)
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)

  useEffect(() => {
    fetchDashboard().then(setData).catch(() => {
      if (!getDashboardCache()) setData(null)
    })
    void send<TrendPoint[]>('GET', '/api/reports/trend').then((r) => r.ok && setTrend(r.data))
  }, [])

  if (!data) return <Skeleton />

  return (
    <div>
      <div className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
        <MagSec title="待办">
          <SpecRow label="活跃作业" note="草稿/排队/打印中" value={data.todo.jobs_active} />
          <SpecRow label="在途订单" note="报价至待取" value={data.todo.orders_active} />
          <SpecRow label="维护提醒" value={data.todo.maintenance_alerts} />
        </MagSec>

        <MagSec title="库存预警">
          {data.inventory_alerts.length === 0 ? (
            <p className="py-2 text-[13px] text-dim">无未解决预警</p>
          ) : (
            data.inventory_alerts.map((a) => (
              <div key={a.id} className="flex items-baseline gap-3 border-b border-line py-[9px]">
                <span
                  className={`font-mono text-[10px] tracking-[.1em] ${a.severity === 'critical' ? 'text-wine-ink' : 'text-warn'}`}
                >
                  {a.severity.toUpperCase()}
                </span>
                <span className="text-[13px] text-ink">{a.message}</span>
              </div>
            ))
          )}
        </MagSec>

        <MagSec title="本月">
          <SpecRow label="完成作业" note={`${data.monthly.pages} 面`} value={data.monthly.jobs_done} />
          <SpecRow label="收入" value={data.monthly.revenue_display} />
          <SpecRow label="外部成本" value={data.monthly.external_cost_display} />
          <SpecRow label="内部消耗" value={data.monthly.internal_cost_display} />
          <div className="flex items-baseline gap-3.5 py-[11px]">
            <span className="min-w-24 text-[15px] font-medium text-ink">毛利</span>
            <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />
            <span
              className={`font-mono text-[15px] tracking-[.05em] ${data.monthly.profit < 0 ? 'text-warn' : 'text-wine-ink'}`}
            >
              {data.monthly.profit_display}
            </span>
          </div>
        </MagSec>

        <MagSec title="设备">
          {data.equipment.map((p) => (
            <div key={p.code} className="flex items-baseline gap-3 border-b border-line py-[9px]">
              <span className="min-w-16 text-[14px] font-medium tracking-[.04em] text-ink">{p.code}</span>
              <span className="font-mono text-[10px] tracking-[.1em] text-dim">{p.status.toUpperCase()}</span>
              <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />
              {p.calibration_due && <span className="font-mono text-[10px] tracking-[.1em] text-warn">校准到期</span>}
              <span className="font-mono text-[12px] text-ink">{p.total_pages}P</span>
            </div>
          ))}
        </MagSec>
      </div>

      {trend && (
        <MagSec title="近 6 月趋势">
          <Suspense fallback={null}>
            <TrendChart trend={trend} />
          </Suspense>
        </MagSec>
      )}

      <MagSec title="设备累计">
        <Suspense fallback={null}>
          <EquipmentChart equipment={data.equipment} />
        </Suspense>
      </MagSec>
    </div>
  )
}

/* ── Customer Dashboard ── */

const ACTIONABLE = new Set<OrderDto['status']>(['file_pending'])
const IN_PROGRESS = new Set<OrderDto['status']>(['confirmed', 'in_production', 'printed', 'file_approved'])
const PICKUP = new Set<OrderDto['status']>(['ready'])

function hasRejectedFile(o: OrderDto) {
  return o.items.some((i) => i.file_status === 'rejected')
}

function OrderRow({ o }: { o: OrderDto }) {
  return (
    <a
      href={`#/order/${o.access_token}`}
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-[12px] hover:bg-card"
    >
      <span className="font-mono text-[13px] text-ink">{o.order_number}</span>
      <StatusBadge status={o.status} />
      {hasRejectedFile(o) && (
        <span className="font-mono text-[10px] tracking-[.1em] text-wine-ink">需改稿</span>
      )}
      {o.quote_expired && (
        <span className="font-mono text-[10px] tracking-[.1em] text-warn">报价过期</span>
      )}
      <span className="text-[12px] text-dim">
        {o.created_at.slice(0, 10)} · {o.items.length} 行
      </span>
      <Leader />
      <span className="font-mono text-[13.5px] text-wine-ink">{o.total_display}</span>
    </a>
  )
}

function CustomerDashboardBody() {
  const [orders, setOrders] = useState<OrderDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetchOrders().then((res) => {
      if (res.ok) setOrders(res.data)
      else setError(`加载失败（${res.status}）`)
    })
  }, [])

  if (error) return <p className="pt-13 text-[14px] text-wine-ink">{error}</p>
  if (!orders) return <p className="pt-13 text-[14px] text-dim">加载中…</p>

  if (orders.length === 0) {
    return (
      <MagSec title="面板">
        <p className="text-[14px] text-dim">还没有订单。</p>
        <div className="mt-4">
          <PillLink href="#/quote" kind="primary">去自助报价下单 →</PillLink>
        </div>
      </MagSec>
    )
  }

  const actionable = orders.filter((o) => ACTIONABLE.has(o.status) || hasRejectedFile(o))
  const pickup = orders.filter((o) => PICKUP.has(o.status))
  const inProgress = orders.filter((o) => IN_PROGRESS.has(o.status))
  const quoted = orders.filter((o) => o.status === 'quoted')
  const finished = orders.filter((o) => o.status === 'delivered' || o.status === 'cancelled')

  return (
    <div>
      {actionable.length > 0 && (
        <MagSec title="需要处理" note={`${actionable.length} 单`}>
          {actionable.map((o) => <OrderRow key={o.id} o={o} />)}
        </MagSec>
      )}

      {pickup.length > 0 && (
        <MagSec title="待取件" note={`${pickup.length} 单`}>
          {pickup.map((o) => <OrderRow key={o.id} o={o} />)}
        </MagSec>
      )}

      {inProgress.length > 0 && (
        <MagSec title="进行中" note={`${inProgress.length} 单`}>
          {inProgress.map((o) => <OrderRow key={o.id} o={o} />)}
        </MagSec>
      )}

      {quoted.length > 0 && (
        <MagSec title="报价中" note={`${quoted.length} 单`}>
          {quoted.map((o) => <OrderRow key={o.id} o={o} />)}
        </MagSec>
      )}

      {finished.length > 0 && (
        <MagSec title="已完结" note={`${finished.length} 单`}>
          {finished.map((o) => <OrderRow key={o.id} o={o} />)}
        </MagSec>
      )}
    </div>
  )
}

/* ── Role dispatch ── */

export default function Dashboard() {
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)
  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null))
  }, [])

  if (me === undefined) return <Skeleton />
  if (me?.role === 'admin') return <AdminGate>{() => <AdminDashboardBody />}</AdminGate>
  return <CustomerGate>{() => <CustomerDashboardBody />}</CustomerGate>
}
