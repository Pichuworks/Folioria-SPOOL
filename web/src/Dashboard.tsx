import { lazy, Suspense, useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import { fetchDashboard, getDashboardCache, send, type DashboardDto } from './api'
import type { TrendPoint } from './DashboardCharts'
import { MagSec, Skeleton, SpecRow } from './spec'

const TrendChart = lazy(() => import('./DashboardCharts').then((m) => ({ default: m.TrendChart })))
const EquipmentChart = lazy(() => import('./DashboardCharts').then((m) => ({ default: m.EquipmentChart })))

function DashboardBody() {
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
        <MagSec tag="01" title="待办" note="ACTIVE">
          <SpecRow label="活跃作业" note="草稿/排队/打印中" value={data.todo.jobs_active} />
          <SpecRow label="在途订单" note="报价至待取" value={data.todo.orders_active} />
          <SpecRow label="维护提醒" value={data.todo.maintenance_alerts} />
        </MagSec>

        <MagSec tag="02" title="库存预警" note="UNRESOLVED">
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

        <MagSec tag="03" title="本月" note="MONTHLY">
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

        <MagSec tag="04" title="设备" note="FLEET">
          {data.equipment.map((p) => (
            <div key={p.code} className="flex items-baseline gap-3 border-b border-line py-[9px]">
              <span className="min-w-16 text-[14px] font-medium text-ink">{p.code}</span>
              <span className="font-mono text-[10px] tracking-[.1em] text-dim">{p.status.toUpperCase()}</span>
              <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />
              {p.calibration_due && <span className="font-mono text-[10px] tracking-[.1em] text-warn">校准到期</span>}
              <span className="font-mono text-[12px] text-ink">{p.total_pages}P</span>
            </div>
          ))}
        </MagSec>
      </div>

      {trend && (
        <MagSec tag="05" title="近 6 月趋势" note="REVENUE · COST · PROFIT">
          <Suspense fallback={null}>
            <TrendChart trend={trend} />
          </Suspense>
        </MagSec>
      )}

      <MagSec tag="06" title="设备累计" note="TOTAL PAGES BY UNIT">
        <Suspense fallback={null}>
          <EquipmentChart equipment={data.equipment} />
        </Suspense>
      </MagSec>
    </div>
  )
}

export default function Dashboard() {
  return <AdminGate>{() => <DashboardBody />}</AdminGate>
}
