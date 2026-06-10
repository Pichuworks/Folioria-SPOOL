import { useEffect, useMemo, useState } from 'react'
import { fetchOptions, fetchQuote, type OptionsDto, type QuoteDto } from './api'

export default function Calculator() {
  const [options, setOptions] = useState<OptionsDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modeId, setModeId] = useState<number | null>(null)
  const [paperId, setPaperId] = useState<number | null>(null)
  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(100)
  const [quote, setQuote] = useState<QuoteDto | null>(null)

  useEffect(() => {
    fetchOptions()
      .then(setOptions)
      .catch(() => setError('价目数据加载失败'))
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

  if (error) return <p className="p-8 text-red-700">{error}</p>
  if (!options) return <p className="p-8 text-stone-500">加载中…</p>

  return (
    <div className="mx-auto max-w-xl space-y-6 p-8">
      <header>
        <h1 className="font-semibold text-2xl text-emerald-900">S.P.O.O.L. 自助报价</h1>
        <p className="text-sm text-stone-500">选择模式 × 纸张 × 尺寸，实时算价</p>
      </header>

      <div className="space-y-4 rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <label className="block">
          <span className="text-sm font-medium text-stone-700">打印模式</span>
          <select
            className="mt-1 w-full rounded-md border border-stone-300 p-2"
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
        </label>

        <label className="block">
          <span className="text-sm font-medium text-stone-700">纸张</span>
          <select
            className="mt-1 w-full rounded-md border border-stone-300 p-2 disabled:bg-stone-100"
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
        </label>

        <label className="block">
          <span className="text-sm font-medium text-stone-700">尺寸</span>
          <select
            className="mt-1 w-full rounded-md border border-stone-300 p-2 disabled:bg-stone-100"
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
        </label>

        <label className="block">
          <span className="text-sm font-medium text-stone-700">数量（张）</span>
          <input
            type="number"
            min={1}
            className="mt-1 w-full rounded-md border border-stone-300 p-2"
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
          />
        </label>
      </div>

      {quote && (
        <div className="rounded-lg bg-emerald-900 p-6 text-emerald-50">
          <p className="text-sm opacity-80">
            单价 {quote.unit_display} × {quote.quantity} 张
          </p>
          <p className="mt-1 font-semibold text-3xl">{quote.line_total_display}</p>
        </div>
      )}
    </div>
  )
}
