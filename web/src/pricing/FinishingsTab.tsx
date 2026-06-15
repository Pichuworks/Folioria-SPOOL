import { useState, type FormEvent } from 'react'
import { send } from '../api'
import { Field, Leader, PillBtn, specInput } from '../spec'
import { actionBtn, type FinishingDto } from './types'

const PRICING_OPTIONS = [
  { v: 'per_book', l: '按本' },
  { v: 'per_page', l: '按页' },
  { v: 'per_area', l: '按面积' },
]
const pricingLabel = (p: string) => PRICING_OPTIONS.find((o) => o.v === p)?.l ?? p

export default function FinishingsTab({
  finishings,
  onChanged,
}: {
  finishings: FinishingDto[]
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [pricing, setPricing] = useState('per_book')
  const [priceC, setPriceC] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const price = Math.trunc(Number(priceC))
    if (name.trim() === '' || price < 0) {
      setNotice('名称非空、价格非负整数 _c')
      return
    }
    const res = await send('POST', '/api/pricing/finishings', { name: name.trim(), pricing, price_c: price })
    if (res.ok) {
      setName('')
      setPriceC('')
      setNotice(null)
      setShowAdd(false)
      onChanged()
    } else setNotice('创建失败')
  }

  const active = finishings.filter((f) => f.archived === 0)

  return (
    <div>
      <div className="mb-3 flex items-baseline gap-2 border-b border-ink pb-1.5">
        <span className="bg-ink px-2 py-0.5 font-mono text-[10px] tracking-[.18em] text-paper">工艺库</span>
        <span className="font-mono text-[10px] tracking-[.1em] text-dim">FINISHING OPS</span>
        <Leader />
        <button
          type="button"
          className={`${actionBtn} text-wine-ink`}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? '收起' : '+ 新增工艺'}
        </button>
      </div>

      {active.length > 0 ? (
        <div className="overflow-x-auto border border-line">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-card">
                <th className="px-4 py-2 text-left font-mono text-[10px] tracking-[.12em] text-dim">工艺名</th>
                <th className="px-3 py-2 text-left font-mono text-[10px] tracking-[.12em] text-dim">计价口径</th>
                <th className="px-3 py-2 text-right font-mono text-[10px] tracking-[.12em] text-dim">单价 _c</th>
                <th className="w-16 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {active.map((f) => (
                <tr key={f.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-[7px] font-medium text-ink">{f.name}</td>
                  <td className="px-3 py-[7px] text-[12px] text-dim">{pricingLabel(f.pricing)}</td>
                  <td className="px-3 py-[7px] text-right font-mono text-[12px] text-ink">{f.price_c.toLocaleString()}</td>
                  <td className="px-3 py-[7px] text-right">
                    <button
                      type="button"
                      className={`${actionBtn} text-dim`}
                      onClick={() => {
                        if (window.confirm(`归档工艺「${f.name}」？`)) {
                          void send('DELETE', `/api/pricing/finishings/${f.id}`).then((r) => r.ok && onChanged())
                        }
                      }}
                    >
                      归档
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-2 text-[12px] text-dim">暂无工艺。</p>
      )}

      {showAdd && (
        <form onSubmit={(e) => void add(e)} className="mt-3 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
          <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW FINISHING</span>
          <Field label="工艺名">
            <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="计价口径">
            <select className={specInput} value={pricing} onChange={(e) => setPricing(e.target.value)}>
              {PRICING_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
          </Field>
          <Field label="单价 _c（本/页/面积）">
            <input type="number" min={0} required className={specInput} value={priceC} onChange={(e) => setPriceC(e.target.value)} />
          </Field>
          <PillBtn>新增工艺</PillBtn>
          {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
        </form>
      )}
    </div>
  )
}
