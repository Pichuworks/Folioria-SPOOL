import { useEffect, useMemo, useState } from 'react'
import { fetchProducts, getProductsCache, type ProductsDto } from './api'
import { MagSec, PillLink } from './spec'

const CAT_LABEL: Record<string, string> = {
  bw: '黑白',
  color: '彩色',
  'photo-value': '照片·性价比',
  'photo-premium': '照片·高质量',
  'photo-art': '照片·艺术微喷',
}
const TECH_LABEL: Record<string, string> = { laser: '激光', inkjet: '喷墨' }

interface Row {
  key: string
  category: string
  label: string
  prices: Record<string, string>
}

export default function PriceList() {
  const [data, setData] = useState<ProductsDto | null>(getProductsCache)
  const [error, setError] = useState<string | null>(null)
  const [catFilter, setCatFilter] = useState<string | null>(null)

  useEffect(() => {
    fetchProducts()
      .then(setData)
      .catch(() => {
        if (!getProductsCache()) setError('价目数据加载失败')
      })
  }, [])

  const sizes = useMemo(() => (data?.sizes ?? []).slice().sort((a, b) => a.sort - b.sort), [data])
  const rows: Row[] = useMemo(() => {
    if (!data) return []
    const paperName = (id: number) => data.papers.find((p) => p.id === id)?.name ?? `纸 ${id}`
    const map = new Map<string, Row>()
    for (const p of data.products) {
      const key = [p.category, p.tech, p.paper_id, p.duplex ? 1 : 0].join('|')
      let row = map.get(key)
      if (!row) {
        const photo = p.category.startsWith('photo-')
        const tech = photo ? '' : ` · ${TECH_LABEL[p.tech] ?? p.tech}`
        const side = photo ? '' : p.duplex ? ' · 双面' : ' · 单面'
        row = {
          key,
          category: p.category,
          label: `${CAT_LABEL[p.category] ?? p.category}${tech} · ${paperName(p.paper_id)}${side}`,
          prices: {},
        }
        map.set(key, row)
      }
      row.prices[p.size_key] = p.display
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh'))
  }, [data])

  const categories = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows) if (!seen.has(r.category)) seen.add(r.category)
    return [...seen]
  }, [rows])

  const filtered = catFilter ? rows.filter((r) => r.category === catFilter) : rows

  if (error) return <p className="pt-13 text-[14px] text-wine-ink">{error}</p>
  if (!data) return <p className="pt-13 text-[14px] text-dim">价目加载中…</p>

  const catBtn = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-[12px] transition-opacity ${
      active ? 'border-wine bg-wine text-cream' : 'border-line text-dim hover:text-ink'
    }`

  return (
    <MagSec title="价目表" note={`${filtered.length} / ${rows.length} 种`}>
      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" className={catBtn(catFilter === null)} onClick={() => setCatFilter(null)}>
          全部
        </button>
        {categories.map((c) => (
          <button key={c} type="button" className={catBtn(catFilter === c)} onClick={() => setCatFilter(c)}>
            {CAT_LABEL[c] ?? c}
          </button>
        ))}
      </div>

      {/* Mobile: compact card list */}
      <div className="border border-ink md:hidden">
        {filtered.map((r) => (
          <div key={r.key} className="border-b border-line px-4 py-3 last:border-b-0">
            <div className="text-[13px] font-medium leading-snug text-ink">{r.label}</div>
            <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-0.5">
              {sizes.map((s) =>
                r.prices[s.key] ? (
                  <span key={s.key} className="inline-flex items-baseline gap-1 font-mono text-[12.5px]">
                    <span className="text-[10px] tracking-[.1em] text-dim">{s.label}</span>
                    <span className="text-wine-ink">{r.prices[s.key]}</span>
                  </span>
                ) : null,
              )}
            </div>
          </div>
        ))}
      </div>
      {/* Desktop: table */}
      <div className="hidden overflow-x-auto border border-ink md:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-ink bg-card">
              <th className="px-4 py-3 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">类别 · 纸张</th>
              {sizes.map((s) => (
                <th key={s.key} className="px-3 py-3 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">
                  {s.label.toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.key} className="border-b border-line last:border-b-0">
                <td className="px-4 py-[10px]">
                  <span className="font-medium text-ink">{r.label}</span>
                </td>
                {sizes.map((s) => (
                  <td key={s.key} className="px-3 py-[10px] text-right font-mono text-[12.5px]">
                    {r.prices[s.key] ? (
                      <span className="text-wine-ink">{r.prices[s.key]}</span>
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
      </div>
    </MagSec>
  )
}
