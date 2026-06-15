import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { DashboardDto } from './api'
import { CHART_COLORS, CHART_STYLE } from './chart-theme'

export interface TrendPoint {
  month: string
  revenue: number
  cost: number
  profit: number
  revenue_display: string
  cost_display: string
  profit_display: string
}

export function TrendChart({ trend }: { trend: TrendPoint[] }) {
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

export function EquipmentChart({ equipment }: { equipment: DashboardDto['equipment'] }) {
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
