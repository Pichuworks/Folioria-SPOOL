import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import AdminGate from './AdminGate'
import { fetchDashboard, getDashboardCache, send, type DashboardDto } from './api'
import { CHART_COLORS, CHART_STYLE } from './chart-theme'
import { MagSec, SpecRow } from './spec'

interface TrendPoint {
  month: string
  revenue: number
  cost: number
  profit: number
  revenue_display: string
  cost_display: string
  profit_display: string
}

function TrendChart({ trend }: { trend: TrendPoint[] }) {
  if (trend.every((t) => t.revenue === 0 && t.cost === 0)) {
    return <p className="py-4 text-[13px] text-dim">近 6 月无对外业务数据</p>
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis dataKey="month" tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} tickFormatter={(m: string) => m.slice(5)} />
        <YAxis tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} width={50} />
        <Tooltip contentStyle={{ ...CHART_STYLE, background: CHART_COLORS.bg, border: `1px solid ${CHART_COLORS.grid}` }} />
        <Legend wrapperStyle={CHART_STYLE} />
        <Bar dataKey="revenue" name="收入" fill={CHART_COLORS.revenue} radius={[2, 2, 0, 0]} />
        <Bar dataKey="cost" name="成本" fill={CHART_COLORS.cost} radius={[2, 2, 0, 0]} />
        <Bar dataKey="profit" name="毛利" fill={CHART_COLORS.profit} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function EquipmentChart({ equipment }: { equipment: DashboardDto['equipment'] }) {
  if (equipment.length === 0) return null
  const data = equipment.map((p) => ({ name: p.code, pages: p.total_pages }))
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, equipment.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis type="number" tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} />
        <YAxis type="category" dataKey="name" tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} width={50} />
        <Tooltip contentStyle={{ ...CHART_STYLE, background: CHART_COLORS.bg, border: `1px solid ${CHART_COLORS.grid}` }} />
        <Bar dataKey="pages" name="累计页数" fill={CHART_COLORS.revenue} radius={[0, 2, 2, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function DashboardBody() {
  const [data, setData] = useState<DashboardDto | null>(getDashboardCache)
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)

  useEffect(() => {
    fetchDashboard().then(setData).catch(() => {
      if (!getDashboardCache()) setData(null)
    })
    void send<TrendPoint[]>('GET', '/api/reports/trend').then((r) => r.ok && setTrend(r.data))
  }, [])

  if (!data) return <p className="pt-13 text-[14px] text-dim">加载中…</p>

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
          <TrendChart trend={trend} />
        </MagSec>
      )}

      <MagSec tag="06" title="设备累计" note="TOTAL PAGES BY UNIT">
        <EquipmentChart equipment={data.equipment} />
      </MagSec>
    </div>
  )
}

export default function Dashboard() {
  return <AdminGate>{() => <DashboardBody />}</AdminGate>
}
