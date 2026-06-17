import { lazy, Suspense, useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import type { MonthlyDto, UsageDto, ConsumptionDto } from './ReportsCharts'
import { Field, Leader, MagSec, SpecRow, TabBar, specInput } from './spec'

const MonthlyChart = lazy(() => import('./ReportsCharts').then((m) => ({ default: m.MonthlyChart })))
const UsageChart = lazy(() => import('./ReportsCharts').then((m) => ({ default: m.UsageChart })))
const ConsumptionChart = lazy(() => import('./ReportsCharts').then((m) => ({ default: m.ConsumptionChart })))

interface SnapshotDto {
  month: string
  jobs_done: number
  ext_revenue_display: string
  ext_profit_display: string
  int_cost_display: string
  generated_at: string
}

const TABS = [
  { key: 'monthly', label: '损益' },
  { key: 'usage', label: '设备利用' },
  { key: 'consumption', label: '纸张消耗' },
  { key: 'snapshots', label: '历史快照' },
] as const

type TabKey = (typeof TABS)[number]['key']

function ExportLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink"
    >
      导出 CSV ↧
    </a>
  )
}

function ReportsBody() {
  const [tab, setTab] = useState<TabKey>('monthly')
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [monthly, setMonthly] = useState<MonthlyDto | null>(null)
  const [usage, setUsage] = useState<UsageDto | null>(null)
  const [consumption, setConsumption] = useState<ConsumptionDto | null>(null)
  const [snapshots, setSnapshots] = useState<SnapshotDto[] | null>(null)

  useEffect(() => {
    void send<SnapshotDto[]>('GET', '/api/reports/snapshots').then((r) => r.ok && setSnapshots(r.data))
  }, [])

  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return
    let cancelled = false
    const qs = `?month=${month}`
    void send<MonthlyDto>('GET', `/api/reports/monthly${qs}`).then((r) => { if (r.ok && !cancelled) setMonthly(r.data) })
    void send<UsageDto>('GET', `/api/reports/equipment-usage${qs}`).then((r) => { if (r.ok && !cancelled) setUsage(r.data) })
    void send<ConsumptionDto>('GET', `/api/reports/paper-consumption${qs}`).then((r) => { if (r.ok && !cancelled) setConsumption(r.data) })
    return () => { cancelled = true }
  }, [month])

  return (
    <MagSec title="月报">
      <div className="mb-4 max-w-44">
        <Field label="报表月份">
          <input type="month" className={specInput} value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
      </div>
      <TabBar tabs={[...TABS]} active={tab} onChange={(k) => setTab(k as TabKey)} />

      {tab === 'monthly' && (
        <div className="pt-5">
          {!monthly ? (
            <p className="py-2 text-[13px] text-dim">加载中…</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
                <div>
                  <div className="mb-1 font-mono text-[10px] tracking-[.14em] text-dim">EXTERNAL · 对外</div>
                  <SpecRow label="完成作业" value={monthly.external.jobs} />
                  <SpecRow label="收入" value={monthly.external.revenue_display} />
                  <SpecRow label="成本" value={monthly.external.cost_display} />
                  <div className="flex items-baseline gap-3.5 py-[11px]">
                    <span className="min-w-24 text-[15px] font-medium text-ink">毛利</span>
                    <Leader />
                    <span className={`font-mono text-[15px] tracking-[.05em] ${monthly.external.profit < 0 ? 'text-warn' : 'text-wine-ink'}`}>
                      {monthly.external.profit_display}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="mb-1 font-mono text-[10px] tracking-[.14em] text-dim">INTERNAL · 内部消耗</div>
                  <SpecRow label="内部作业" value={monthly.internal.jobs} />
                  <SpecRow label="内部页数" value={`${monthly.internal.pages} 面`} />
                  <SpecRow label="内部成本" value={monthly.internal.cost_display} strong />
                  <SpecRow
                    label="作废核销"
                    note="取消单已发生成本"
                    value={`${monthly.writeoff.jobs} 单 · ${monthly.writeoff.cost_display}`}
                  />
                  <SpecRow label="全月合计" note="含内外" value={`${monthly.jobs_done} 单 · ${monthly.pages} 面`} />
                </div>
              </div>
              <Suspense fallback={null}><MonthlyChart data={monthly} /></Suspense>
            </>
          )}
          <div className="mt-3 text-right">
            <ExportLink href={`/api/reports/monthly/export?month=${month}`} />
          </div>
        </div>
      )}

      {tab === 'usage' && (
        <div className="pt-5">
          {!usage ? (
            <p className="py-2 text-[13px] text-dim">加载中…</p>
          ) : (
            <>
              {usage.printers.map((p) => (
                <div key={p.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-[8px]">
                  <span className="min-w-16 text-[14px] font-medium tracking-[.04em] text-ink">{p.code}</span>
                  <span className="font-mono text-[10px] tracking-[.1em] text-dim">{p.status.toUpperCase()}</span>
                  <span className="text-[11.5px] text-dim">{p.month_jobs} 单</span>
                  <Leader />
                  <span className="font-mono text-[12px] text-ink">
                    本月 {p.month_pages}P / 累计 {p.total_pages}P
                  </span>
                </div>
              ))}
              <Suspense fallback={null}><UsageChart data={usage} /></Suspense>
            </>
          )}
          <div className="mt-3 text-right">
            <ExportLink href={`/api/reports/equipment-usage/export?month=${month}`} />
          </div>
        </div>
      )}

      {tab === 'consumption' && (
        <div className="pt-5">
          {!consumption ? (
            <p className="py-2 text-[13px] text-dim">加载中…</p>
          ) : consumption.rows.length === 0 ? (
            <p className="py-2 text-[13px] text-dim">本月无出库记录</p>
          ) : (
            <>
              {consumption.rows.map((r) => (
                <div key={`${r.paper_id}:${r.size_key}`} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-[8px]">
                  <span className="text-[14px] font-medium tracking-[.04em] text-ink">{r.name}</span>
                  <span className="text-[12px] text-dim">{r.size_key}</span>
                  {r.scrapped > 0 && <span className="font-mono text-[10px] tracking-[.1em] text-warn">废 {r.scrapped}</span>}
                  <Leader />
                  <span className="font-mono text-[13px] text-ink">{r.total} 张</span>
                </div>
              ))}
              <Suspense fallback={null}><ConsumptionChart data={consumption} /></Suspense>
            </>
          )}
          <div className="mt-3 text-right">
            <ExportLink href={`/api/reports/paper-consumption/export?month=${month}`} />
          </div>
        </div>
      )}

      {tab === 'snapshots' && (
        <div className="pt-5">
          {!snapshots || snapshots.length === 0 ? (
            <p className="py-2 text-[13px] text-dim">暂无历史快照</p>
          ) : (
            snapshots.map((s) => (
              <div key={s.month} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-[8px]">
                <span className="min-w-16 font-mono text-[13px] font-medium text-ink">{s.month}</span>
                <span className="text-[11.5px] text-dim">{s.jobs_done} 单</span>
                <span className="text-[12px] text-dim">营收 {s.ext_revenue_display}</span>
                <Leader />
                <span className="font-mono text-[12px] text-wine-ink">毛利 {s.ext_profit_display}</span>
                <span className="font-mono text-[10px] tracking-[.1em] text-dim">{s.generated_at.slice(0, 10)} 归档</span>
              </div>
            ))
          )}
        </div>
      )}
    </MagSec>
  )
}

export default function AdminReports() {
  return <AdminGate>{() => <ReportsBody />}</AdminGate>
}
