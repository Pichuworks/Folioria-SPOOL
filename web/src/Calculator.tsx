import { useEffect, useMemo, useState } from 'react'
import { fetchOptions, fetchQuote, getOptionsCache, type OptionsDto, type QuoteDto } from './api'
import { Field, MagSec, SpecRow, specInput } from './spec'

type QuoteState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

export default function Calculator() {
  const [options, setOptions] = useState<OptionsDto | null>(getOptionsCache)
  const [error, setError] = useState<string | null>(null)
  const [modeId, setModeId] = useState<number | null>(null)
  const [paperId, setPaperId] = useState<number | null>(null)
  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(100)
  const [quote, setQuote] = useState<QuoteDto | null>(null)
  const [quoteState, setQuoteState] = useState<QuoteState>('idle')

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
    if (modeId === null || paperId === null || sizeKey === null || quantity < 1) {
      setQuoteState('idle')
      return
    }
    if (!pricesForPair || !(sizeKey in pricesForPair)) {
      setQuoteState('idle')
      return
    }
    setQuoteState('loading')
    const ctl = new AbortController()
    fetchQuote({ mode_id: modeId, paper_id: paperId, size_key: sizeKey, quantity })
      .then((q) => {
        if (ctl.signal.aborted) return
        setQuote(q)
        setQuoteState(q ? 'ready' : 'unavailable')
      })
      .catch(() => {
        if (!ctl.signal.aborted) setQuoteState('error')
      })
    return () => ctl.abort()
  }, [modeId, paperId, sizeKey, quantity, pricesForPair])

  if (error) return <p className="pt-13 text-[14px] text-wine-ink">{error}</p>
  if (!options) return <p className="pt-13 text-[14px] text-dim">价目加载中…</p>

  return (
    <MagSec tag="报价" title="自助报价" note="CONFIG × PAPER × SIZE · REALTIME">
      <div className="grid grid-cols-1 border border-ink md:grid-cols-[5fr_7fr]">
        {/* 左栏：配置 */}
        <div className="space-y-5 border-b border-ink p-7 md:border-b-0 md:border-r">
          <div className="font-mono text-[10px] tracking-[.14em] text-dim">CONFIGURATION</div>
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

        {/* 右栏：报价 */}
        <div className="flex flex-col p-7">
          <div className="font-mono text-[10px] tracking-[.14em] text-dim">QUOTATION</div>
          {quoteState === 'ready' && quote ? (
            <div className="flex flex-1 flex-col">
              <div className="mt-3">
                <SpecRow label="单价" note="每张" value={quote.unit_display} />
                <SpecRow label="数量" value={`${quote.quantity} 张`} />
              </div>
              <div className="mt-auto pt-8">
                <div className="flex items-baseline justify-between border-t-2 border-ink pt-4">
                  <span className="text-[15px] font-medium text-ink">合计</span>
                  <span className="text-[44px] font-semibold leading-none tracking-[.02em] text-wine-ink">
                    {quote.line_total_display}
                  </span>
                </div>
                <p className="mt-3 text-right font-mono text-[10px] tracking-[.12em] text-dim">
                  UNIT × QTY · ROUND HALF UP · {quote.currency}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-start justify-center gap-2 py-12">
              <span className="text-[40px] font-medium leading-none text-dim opacity-60">
                {options.currency.symbol} ——
              </span>
              <p className="text-[13px] leading-[1.85] text-dim">
                {quoteState === 'loading'
                  ? '计算中…'
                  : quoteState === 'unavailable'
                    ? '该组合暂不可报价，请调整配置。'
                    : quoteState === 'error'
                      ? '报价服务暂时不可用，请稍后重试。'
                      : '选定左侧配置，报价即时出现。'}
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3.5 flex items-baseline justify-between">
        <span className="text-[11.5px] text-dim">
          图版 · 价格按当前配置实时推导，下单时单价定格。<sup className="text-wine-ink">※</sup>
        </span>
        <span className="font-mono text-[10px] tracking-[.12em] text-dim">PLATE Q1</span>
      </div>
      <div className="mt-4 max-w-[300px] border-t border-ink pt-2">
        <p className="text-[10.5px] leading-[1.9] text-dim">※ — 报价为打印输出价格；寄送与其他需求在委托确认时商定。</p>
      </div>
    </MagSec>
  )
}
