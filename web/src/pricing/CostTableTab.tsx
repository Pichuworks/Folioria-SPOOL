import { useMemo, useState } from 'react'
import { Paginator, usePagination } from '../spec'
import {
  FILTER_OPTIONS,
  FLAG_BG,
  FLAG_STYLE,
  type ModeDto,
  type PaperDto,
  type QuoteDto,
} from './types'

export interface CostRow {
  id: string
  modeName: string
  paperName: string
  sizeKey: string
  inkDisplay: string
  paperDisplay: string
  totalDisplay: string
  autoDisplay: string
  sellDisplay: string
  source: string
  flag: QuoteDto['flag']
}

export function buildCostRows(quotes: QuoteDto[], modes: ModeDto[], papers: PaperDto[]): CostRow[] {
  const modeName = new Map(modes.map((m) => [m.id, m.name]))
  const paperName = new Map(papers.map((p) => [p.id, p.name]))
  return quotes.map((q) => ({
    id: `${q.mode_id}:${q.paper_id}:${q.size_key}`,
    modeName: modeName.get(q.mode_id) ?? `mode#${q.mode_id}`,
    paperName: paperName.get(q.paper_id) ?? `paper#${q.paper_id}`,
    sizeKey: q.size_key,
    inkDisplay: q.ink_display,
    paperDisplay: q.paper_display,
    totalDisplay: q.total_display,
    autoDisplay: q.auto_display,
    sellDisplay: q.sell_display,
    source: q.source,
    flag: q.flag,
  }))
}

export default function CostTableTab({
  quotes,
  modes,
  papers,
}: {
  quotes: QuoteDto[]
  modes: ModeDto[]
  papers: PaperDto[]
}) {
  const [search, setSearch] = useState('')
  const [flagFilter, setFlagFilter] = useState('all')

  const rows = useMemo(() => buildCostRows(quotes, modes, papers), [quotes, modes, papers])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return rows.filter((r) => {
      const matchesText =
        needle === '' ||
        r.modeName.toLowerCase().includes(needle) ||
        r.paperName.toLowerCase().includes(needle) ||
        r.sizeKey.toLowerCase().includes(needle)
      const matchesFlag = flagFilter === 'all' || r.flag === flagFilter
      return matchesText && matchesFlag
    })
  }, [rows, search, flagFilter])

  const { page, totalPages, paged, setPage } = usePagination(filtered, 30)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-4 pt-5">
        <input
          type="text"
          placeholder="搜索模式 / 纸张 / 尺寸…"
          className="w-56 border border-line bg-card px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-dim/60 focus:border-wine"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {FILTER_OPTIONS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFlagFilter(flagFilter === f.key ? 'all' : f.key)}
              className={`px-2.5 py-1 font-mono text-[10px] tracking-[.1em] ${
                flagFilter === f.key
                  ? 'bg-ink text-paper'
                  : 'text-dim hover:bg-deep hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto border border-ink">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-ink bg-card">
              <th className="min-w-[170px] px-4 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">模式</th>
              <th className="min-w-[210px] px-3 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">纸张</th>
              <th className="px-3 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">尺寸</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">墨耗</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">纸张</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">总成本</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">地板价</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">售价</th>
              <th className="px-3 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">状态</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((r) => {
              const flag = FLAG_STYLE[r.flag]
              return (
                <tr key={r.id} className={`border-b border-line last:border-b-0 ${FLAG_BG[r.flag] ?? ''}`}>
                  <td className="px-4 py-[9px] font-medium text-ink">{r.modeName}</td>
                  <td className="px-3 py-[9px] text-ink">{r.paperName}</td>
                  <td className="px-3 py-[9px] font-mono text-[12px] text-dim">{r.sizeKey}</td>
                  <td className="px-3 py-[9px] text-right font-mono text-[12px] text-ink">{r.inkDisplay}</td>
                  <td className="px-3 py-[9px] text-right font-mono text-[12px] text-ink">{r.paperDisplay}</td>
                  <td className="px-3 py-[9px] text-right font-mono text-[12px] font-medium text-ink">{r.totalDisplay}</td>
                  <td className="px-3 py-[9px] text-right font-mono text-[12px] text-dim">{r.autoDisplay}</td>
                  <td className="px-3 py-[9px] text-right font-mono text-[12px] text-ink">{r.sellDisplay}</td>
                  <td className={`px-3 py-[9px] font-mono text-[11px] ${flag.cls}`}>
                    {flag.label}
                    <span className="ml-1 text-dim">/{r.source}</span>
                  </td>
                </tr>
              )
            })}
            {paged.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-[13px] text-dim">
                  {search || flagFilter !== 'all' ? '无匹配结果' : '暂无成本数据'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Paginator page={page} totalPages={totalPages} onPage={setPage} />

      <div className="pt-3 text-right font-mono text-[10px] tracking-[.1em] text-dim">
        {filtered.length} 条成本口径
      </div>
    </div>
  )
}
