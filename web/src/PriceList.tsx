import { useEffect, useState } from 'react'
import { fetchOptions, getOptionsCache, type OptionsDto } from './api'
import { MagSec, PillLink } from './spec'

/** R8 #/price-list：公开价目表——模式×纸张 行 × 尺寸 列，价格服务端格式化 */
export default function PriceList() {
  const [options, setOptions] = useState<OptionsDto | null>(getOptionsCache)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchOptions()
      .then(setOptions)
      .catch(() => {
        if (!getOptionsCache()) setError('价目数据加载失败')
      })
  }, [])

  if (error) return <p className="pt-13 text-[14px] text-wine-ink">{error}</p>
  if (!options) return <p className="pt-13 text-[14px] text-dim">价目加载中…</p>

  const sizes = options.sizes.slice().sort((a, b) => a.sort - b.sort)
  const modeName = (id: number) => options.modes.find((m) => m.id === id)?.name ?? `模式 ${id}`
  const paperName = (id: number) => options.papers.find((p) => p.id === id)?.name ?? `纸 ${id}`
  const rows = options.options
    .slice()
    .sort((a, b) => a.mode_id - b.mode_id || a.paper_id - b.paper_id)

  return (
    <MagSec tag="价目" title="公开价目表" note={`${rows.length} 组合 · 单张价 · 实时推导`}>
      <div className="overflow-x-auto border border-ink">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-ink bg-card">
              <th className="px-4 py-3 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">MODE × PAPER</th>
              {sizes.map((s) => (
                <th key={s.key} className="px-3 py-3 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">
                  {s.label.toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.mode_id}:${r.paper_id}`} className="border-b border-line last:border-b-0">
                <td className="px-4 py-[10px]">
                  <span className="font-medium text-ink">{modeName(r.mode_id)}</span>
                  <span className="text-dim"> × {paperName(r.paper_id)}</span>
                </td>
                {sizes.map((s) => (
                  <td key={s.key} className="px-3 py-[10px] text-right font-mono text-[12.5px]">
                    {r.prices[s.key] ? (
                      <span className="text-wine-ink">{r.prices[s.key]?.display}</span>
                    ) : (
                      <span className="text-dim opacity-50">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5 flex items-center gap-4">
        <PillLink href="#/quote" kind="primary">按此价目在线下单 →</PillLink>
        <span className="font-mono text-[10.5px] tracking-[.12em] text-dim">价格由成本模型实时推导 · 下单时单价定格</span>
      </div>
    </MagSec>
  )
}
