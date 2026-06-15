import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { CHART_COLORS, CHART_STYLE } from './chart-theme'

export interface MonthlyDto {
  month: string
  jobs_done: number
  pages: number
  external: {
    jobs: number
    revenue: number
    cost: number
    profit: number
    revenue_display: string
    cost_display: string
    profit_display: string
  }
  internal: { jobs: number; pages: number; cost_display: string }
  writeoff: { jobs: number; cost: number; cost_display: string }
}

export interface UsageDto {
  month: string
  printers: Array<{
    id: number
    code: string
    name: string
    status: string
    total_pages: number
    month_pages: number
    month_jobs: number
  }>
}

export interface ConsumptionDto {
  month: string
  rows: Array<{
    paper_id: number
    name: string
    size_key: string
    consumed: number
    scrapped: number
    total: number
  }>
}

const tooltipStyle = {
  ...CHART_STYLE,
  background: CHART_COLORS.bg,
  border: `1px solid ${CHART_COLORS.grid}`,
}

export function MonthlyChart({ data }: { data: MonthlyDto }) {
  const chartData = [
    { name: '收入', value: data.external.revenue },
    { name: '成本', value: data.external.cost },
    { name: '毛利', value: data.external.profit },
  ]
  if (chartData.every((d) => d.value === 0)) return null
  const colors = [CHART_COLORS.revenue, CHART_COLORS.cost, CHART_COLORS.profit]
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis dataKey="name" tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} />
        <YAxis tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} width={50} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey="value" name="金额" radius={[2, 2, 0, 0]}>
          {chartData.map((_entry, i) => (
            <rect key={i} fill={colors[i % colors.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export function UsageChart({ data }: { data: UsageDto }) {
  if (data.printers.length === 0 || data.printers.every((p) => p.month_pages === 0)) return null
  const chartData = data.printers.map((p) => ({ name: p.code, pages: p.month_pages }))
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, data.printers.length * 36)}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis type="number" tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} />
        <YAxis type="category" dataKey="name" tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} width={50} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey="pages" name="本月面数" fill={CHART_COLORS.revenue} radius={[0, 2, 2, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function ConsumptionChart({ data }: { data: ConsumptionDto }) {
  if (data.rows.length === 0) return null
  const top10 = data.rows.slice(0, 10)
  const chartData = top10.map((r) => ({
    name: `${r.name} ${r.size_key}`,
    consumed: r.consumed,
    scrapped: r.scrapped,
  }))
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, top10.length * 36)}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis type="number" tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} />
        <YAxis type="category" dataKey="name" tick={{ ...CHART_STYLE, fill: CHART_COLORS.text }} width={100} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey="consumed" name="消耗" stackId="a" fill={CHART_COLORS.revenue} />
        <Bar dataKey="scrapped" name="废品" stackId="a" fill={CHART_COLORS.cost} radius={[0, 2, 2, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
