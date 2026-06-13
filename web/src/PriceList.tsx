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
  label: string
  prices: Record<string, string>
}

/** ③⑤ #/price-list：公开价目表——按客户产品（类别×技术×纸×单双面），机器不可见 */
export default function PriceList() {
  const [data, setData] = useState<ProductsDto | null>(getProductsCache)
  const [error, setError] = useState<string | null>(null)

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
        row = { key, label: `${CAT_LABEL[p.category] ?? p.category}${tech} · ${paperName(p.paper_id)}${side}`, prices: {} }
        map.set(key, row)
      }
      row.prices[p.size_key] = p.display
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh'))
  }, [data])

  if (error) return <p className="pt-13 text-[14px] text-wine-ink">{error}</p>
  if (!data) return <p className="pt-13 text-[14px] text-dim">价目加载中…</p>

  return (
    <MagSec tag="价目" title="公开价目表" note={`${rows.length} 种 · 单张价 · 实时推导`}>
      <div className="overflow-x-auto border border-ink">
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
            {rows.map((r) => (
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
        <span className="font-mono text-[10.5px] tracking-[.12em] text-dim">价格由成本模型实时推导 · 下单时单价定格</span>
      </div>
    </MagSec>
  )
}
