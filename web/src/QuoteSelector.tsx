import { useEffect, useMemo, useState } from 'react'
import {
  fetchFinishingCatalog,
  fetchQuote,
  type FinishingCatalogItem,
  type ProductDto,
  type ProductsDto,
  type QuoteDto,
} from './api'
import { Field, specInput } from './spec'

type QuoteState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

const CAT_LABEL: Record<string, string> = {
  bw: '黑白',
  color: '彩色',
  'photo-value': '照片·性价比',
  'photo-premium': '照片·高质量',
  'photo-art': '照片·艺术微喷',
}
const TECH_LABEL: Record<string, string> = { laser: '激光', inkjet: '喷墨' }
const GRADE_LABEL: Record<string, string> = { 'photo-value': '性价比', 'photo-premium': '高质量', 'photo-art': '艺术微喷' }

export interface ItemCartLine {
  kind: 'item'
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  finishing_ids: number[]
  label: string
  unit_display: string
  line_total_display: string
}

interface Props {
  data: ProductsDto
  onAdd: (line: ItemCartLine) => void
}

export default function QuoteSelector({ data, onAdd }: Props) {
  const [category, setCategory] = useState<'bw' | 'color' | 'photo' | null>(null)
  const [grade, setGrade] = useState<string | null>(null)
  const [tech, setTech] = useState<string | null>(null)
  const [duplex, setDuplex] = useState<boolean | null>(null)
  const [paperId, setPaperId] = useState<number | null>(null)
  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(100)
  const [quote, setQuote] = useState<QuoteDto | null>(null)
  const [quoteState, setQuoteState] = useState<QuoteState>('idle')
  const [finishingCatalog, setFinishingCatalog] = useState<FinishingCatalogItem[]>([])
  const [selectedFinishings, setSelectedFinishings] = useState<Set<number>>(new Set())

  useEffect(() => {
    fetchFinishingCatalog().then((c) => c && setFinishingCatalog(c.finishings)).catch(() => {})
  }, [])

  const products = useMemo(() => data.products, [data])
  const paperName = (id: number) => data.papers.find((p) => p.id === id)?.name ?? `纸 ${id}`
  const sizeLabel = (k: string) => data.sizes.find((s) => s.key === k)?.label ?? k

  const hasBw = products.some((p) => p.category === 'bw')
  const hasColor = products.some((p) => p.category === 'color')
  const photoGrades = useMemo(
    () => [...new Set(products.filter((p) => p.category.startsWith('photo-')).map((p) => p.category))],
    [products],
  )

  const effCat = category === 'photo' ? grade : category
  const pool = useMemo(() => (effCat ? products.filter((p) => p.category === effCat) : []), [products, effCat])
  const papers = useMemo(() => {
    const ids = new Set(pool.map((p) => p.paper_id))
    return data.papers.filter((p) => ids.has(p.id))
  }, [pool, data])
  const afterPaper = useMemo(() => pool.filter((p) => paperId == null || p.paper_id === paperId), [pool, paperId])
  const sizes = useMemo(() => {
    const keys = new Set(afterPaper.map((p) => p.size_key))
    return data.sizes.filter((s) => keys.has(s.key)).sort((a, b) => a.sort - b.sort)
  }, [afterPaper, data])
  const afterSize = useMemo(
    () => afterPaper.filter((p) => sizeKey == null || p.size_key === sizeKey),
    [afterPaper, sizeKey],
  )
  const techs = useMemo(() => [...new Set(afterSize.map((p) => p.tech))], [afterSize])
  const duplexes = useMemo(() => [...new Set(afterSize.map((p) => p.duplex))], [afterSize])

  const resolved: ProductDto | null = useMemo(() => {
    if (!effCat) return null
    let c = afterSize
    if (category !== 'photo') {
      if (techs.length > 1) c = tech ? c.filter((p) => p.tech === tech) : []
      if (duplexes.length > 1) c = duplex !== null ? c.filter((p) => p.duplex === duplex) : []
    }
    return c.length === 1 ? (c[0] as ProductDto) : null
  }, [effCat, category, afterSize, techs, tech, duplexes, duplex])

  const finishingIds = useMemo(() => [...selectedFinishings].sort(), [selectedFinishings])
  useEffect(() => {
    setQuote(null)
    if (!resolved || quantity < 1) {
      setQuoteState('idle')
      return
    }
    setQuoteState('loading')
    const ctl = new AbortController()
    fetchQuote({
      mode_id: resolved.mode_id, paper_id: resolved.paper_id, size_key: resolved.size_key, quantity,
      ...(finishingIds.length > 0 ? { finishing_ids: finishingIds } : {}),
    })
      .then((q) => {
        if (ctl.signal.aborted) return
        setQuote(q)
        setQuoteState(q ? 'ready' : 'unavailable')
      })
      .catch(() => {
        if (!ctl.signal.aborted) setQuoteState('error')
      })
    return () => ctl.abort()
  }, [resolved, quantity, finishingIds])

  const pickCategory = (c: 'bw' | 'color' | 'photo') => {
    setCategory(c)
    setGrade(null)
    setTech(null)
    setDuplex(null)
    setPaperId(null)
    setSizeKey(null)
  }

  const addToCart = () => {
    if (!quote || !resolved) return
    const techPart = category !== 'photo' && resolved.tech ? ` · ${TECH_LABEL[resolved.tech] ?? resolved.tech}` : ''
    const sidePart = category !== 'photo' ? (resolved.duplex ? ' · 双面' : ' · 单面') : ''
    const label = `${CAT_LABEL[resolved.category] ?? resolved.category}${techPart} · ${paperName(resolved.paper_id)} · ${sizeLabel(resolved.size_key)}${sidePart}`
    onAdd({
      kind: 'item',
      mode_id: resolved.mode_id,
      paper_id: resolved.paper_id,
      size_key: resolved.size_key,
      quantity: quote.quantity,
      finishing_ids: finishingIds,
      label,
      unit_display: quote.unit_display,
      line_total_display: quote.line_total_display,
    })
  }

  const catBtn = (active: boolean) =>
    `flex-1 rounded-full border px-3 py-2 text-[13.5px] transition-opacity ${
      active ? 'border-wine bg-wine text-cream' : 'border-line text-dim hover:text-ink'
    }`

  return (
    <div className="space-y-5">
      <Field label="类别">
        <div className="flex gap-2">
          {hasBw && (
            <button type="button" className={catBtn(category === 'bw')} onClick={() => pickCategory('bw')}>
              黑白
            </button>
          )}
          {hasColor && (
            <button type="button" className={catBtn(category === 'color')} onClick={() => pickCategory('color')}>
              彩色
            </button>
          )}
          {photoGrades.length > 0 && (
            <button type="button" className={catBtn(category === 'photo')} onClick={() => pickCategory('photo')}>
              照片
            </button>
          )}
        </div>
      </Field>

      {category === 'photo' && (
        <Field label="品质档">
          <select
            className={specInput}
            value={grade ?? ''}
            onChange={(e) => {
              setGrade(e.target.value === '' ? null : e.target.value)
              setPaperId(null)
              setSizeKey(null)
            }}
          >
            <option value="">— 选择 —</option>
            {photoGrades.map((g) => (
              <option key={g} value={g}>
                {GRADE_LABEL[g] ?? g}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="纸张">
        <select
          className={specInput}
          value={paperId ?? ''}
          disabled={!effCat}
          onChange={(e) => {
            setPaperId(e.target.value === '' ? null : Number(e.target.value))
            setSizeKey(null)
          }}
        >
          <option value="">— 选择 —</option>
          {papers.map((p) => (
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
          disabled={paperId === null}
          onChange={(e) => setSizeKey(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">— 选择 —</option>
          {sizes.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>

      {category !== 'photo' && category !== null && techs.length > 1 && (
        <Field label="打印技术">
          <select className={specInput} value={tech ?? ''} onChange={(e) => setTech(e.target.value || null)}>
            <option value="">— 选择 —</option>
            {techs.map((t) => (
              <option key={t} value={t}>
                {TECH_LABEL[t] ?? t}
              </option>
            ))}
          </select>
        </Field>
      )}

      {category !== 'photo' && category !== null && duplexes.length > 1 && (
        <Field label="单面 / 双面">
          <select
            className={specInput}
            value={duplex === null ? '' : duplex ? '1' : '0'}
            onChange={(e) => setDuplex(e.target.value === '' ? null : e.target.value === '1')}
          >
            <option value="">— 选择 —</option>
            <option value="0">单面</option>
            <option value="1">双面</option>
          </select>
        </Field>
      )}

      <Field label="数量（张）">
        <input
          type="number"
          min={1}
          className={specInput}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
        />
      </Field>

      {finishingCatalog.length > 0 && resolved && (
        <div className="pt-1">
          <span className="block pb-1.5 text-[11px] font-medium tracking-[.06em] text-dim">工艺（可选）</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {finishingCatalog.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={selectedFinishings.has(f.id)}
                  onChange={() =>
                    setSelectedFinishings((prev) => {
                      const next = new Set(prev)
                      if (next.has(f.id)) next.delete(f.id)
                      else next.add(f.id)
                      return next
                    })
                  }
                />
                {f.name}
                <span className="text-[11px] text-dim">({f.price_display})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-line pt-4">
        {quoteState === 'ready' && quote ? (
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-dim">
              {quote.unit_display}/张 × {quote.quantity}
            </span>
            <span className="text-[22px] font-semibold text-wine-ink">{quote.line_total_display}</span>
          </div>
        ) : (
          <p className="text-[12.5px] text-dim">
            {quoteState === 'loading'
              ? '计算中…'
              : quoteState === 'unavailable'
                ? '该组合暂不可报价。'
                : quoteState === 'error'
                  ? '报价服务暂时不可用。'
                  : ' '}
          </p>
        )}
        <button
          type="button"
          disabled={quoteState !== 'ready'}
          onClick={addToCart}
          className="mt-3 w-full rounded-full border border-wine px-[18px] py-2.5 text-[14px] font-medium text-wine-ink transition-opacity hover:opacity-80 disabled:border-line disabled:text-dim"
        >
          加入订单清单 ↓
        </button>
      </div>
    </div>
  )
}
