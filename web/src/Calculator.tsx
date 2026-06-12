import { useEffect, useMemo, useState } from 'react'
import { fetchOptions, fetchQuote, getOptionsCache, type OptionsDto, type QuoteDto } from './api'
import { Field, Leader, SpecSec, specInput } from './spec'

export default function Calculator() {
  const [options, setOptions] = useState<OptionsDto | null>(getOptionsCache)
  const [error, setError] = useState<string | null>(null)
  const [modeId, setModeId] = useState<number | null>(null)
  const [paperId, setPaperId] = useState<number | null>(null)
  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(100)
  const [quote, setQuote] = useState<QuoteDto | null>(null)

  useEffect(() => {
    fetchOptions()
      .then(setOptions)
      .catch(() => {
        if (!getOptionsCache()) setError('价目数据加载失败')
      })
  }, [])

  const papersForMode = useMemo(() => {
    if (!options || modeId === null) return []
    const ids = new Set(options.options.filter((o) => o.mode_id === modeId).map((o) => o.paper_id))
    return options.papers.filter((p) => ids.has(p.id))
  }, [options, modeId])

  const pricesForPair = useMemo(() => {
    if (!options || modeId === null || paperId === null) return null
    return options.options.find((o) => o.mode_id === modeId && o.paper_id === paperId)?.prices ?? null
  }, [options, modeId, paperId])

  useEffect(() => {
    setQuote(null)
    if (modeId === null || paperId === null || sizeKey === null || quantity < 1) return
    if (!pricesForPair || !(sizeKey in pricesForPair)) return
    const ctl = new AbortController()
    fetchQuote({ mode_id: modeId, paper_id: paperId, size_key: sizeKey, quantity })
      .then((q) => {
        if (!ctl.signal.aborted) setQuote(q)
      })
      .catch(() => undefined)
    return () => ctl.abort()
  }, [modeId, paperId, sizeKey, quantity, pricesForPair])

  if (error) return <p className="p-10 text-[14px] text-wine-ink">{error}</p>
  if (!options) return <p className="p-10 text-[14px] text-dim">价目加载中…</p>

  return (
    <div className="mx-auto max-w-2xl space-y-10 px-6 py-10">
      <header>
        <div className="mb-2 font-mono text-[10.5px] tracking-[.3em] text-wine-ink">FOLIORIA · QUOTE SPECIMEN</div>
        <h1 className="text-[36px] font-medium tracking-[.02em] text-ink">自助报价</h1>
        <p className="mt-2 text-[14px] leading-[1.85] text-dim">选择工艺、纸张与尺寸，价格由成本模型实时推导。</p>
      </header>

      <SpecSec n="01" title="配置" note="工艺 × 纸张 × 尺寸 × 数量">
        <div className="space-y-5">
          <Field label="打印模式">
            <select
              className={specInput}
              value={modeId ?? ''}
              onChange={(e) => {
                setModeId(e.target.value === '' ? null : Number(e.target.value))
                setPaperId(null)
                setSizeKey(null)
              }}
            >
              <option value="">— 选择 —</option>
              {options.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="纸张">
            <select
              className={specInput}
              value={paperId ?? ''}
              disabled={modeId === null}
              onChange={(e) => {
                setPaperId(e.target.value === '' ? null : Number(e.target.value))
                setSizeKey(null)
              }}
            >
              <option value="">— 选择 —</option>
              {papersForMode.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="尺寸">
            <select
              className={specInput}
              value={sizeKey ?? ''}
              disabled={pricesForPair === null}
              onChange={(e) => setSizeKey(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">— 选择 —</option>
              {options.sizes
                .filter((s) => pricesForPair && s.key in pricesForPair)
                .map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}（{pricesForPair?.[s.key]?.display}/张）
                  </option>
                ))}
            </select>
          </Field>

          <Field label="数量（张）">
            <input
              type="number"
              min={1}
              className={specInput}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
            />
          </Field>
        </div>
      </SpecSec>

      {quote && (
        <SpecSec n="02" title="报价" note="实时推导 · 配置即报价">
          <div className="flex items-baseline gap-3.5 border-b border-line py-[11px]">
            <span className="min-w-24 text-[15px] font-medium text-ink">单价</span>
            <span className="text-[12.5px] text-dim">每张</span>
            <Leader />
            <span className="font-mono text-[13px] tracking-[.05em] text-ink">{quote.unit_display}</span>
          </div>
          <div className="flex items-baseline gap-3.5 border-b border-line py-[11px]">
            <span className="min-w-24 text-[15px] font-medium text-ink">数量</span>
            <Leader />
            <span className="font-mono text-[13px] tracking-[.05em] text-ink">{quote.quantity} 张</span>
          </div>
          <div className="mt-4 flex items-baseline justify-between border-t-2 border-ink pt-4">
            <span className="text-[15px] font-medium text-ink">合计</span>
            <span className="text-[34px] font-semibold tracking-[.02em] text-wine-ink">{quote.line_total_display}</span>
          </div>
          <p className="mt-3 font-mono text-[10.5px] tracking-[.12em] text-dim">UNIT × QTY · ROUND HALF UP · {quote.currency}</p>
        </SpecSec>
      )}
    </div>
  )
}
