import { useEffect, useMemo, useState } from 'react'
import {
  fetchBookConfig,
  fetchBookSpecQuote,
  getBookConfigCache,
  type BookConfigDto,
  type BookConfigPaper,
  type BookSpecQuoteDto,
} from './api'
import { Field, Leader, specInput } from './spec'

export interface BookCartLine {
  kind: 'book'
  count: number
  size_key: string
  components: Array<{
    role: 'cover' | 'inner' | 'insert'
    paper_id: number
    color_class: string
    duplex: number
    sheets_per_book: number
  }>
  finishing_ids: number[]
  label: string
  line_total_display: string
}

interface InnerSection {
  paper_id: number | null
  color_class: 'bw' | 'color'
  duplex: 0 | 1
  sheets: number
}

const COLOR_LABEL: Record<string, string> = { bw: '黑白', color: '彩色' }

type QState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

function newInner(): InnerSection {
  return { paper_id: null, color_class: 'bw', duplex: 0, sheets: 20 }
}

/** D36 自定义书册配置器：扁平自助表单 */
export default function BookConfigurator({ onAdd }: { onAdd: (line: BookCartLine) => void }) {
  const [cfg, setCfg] = useState<BookConfigDto | null>(getBookConfigCache)
  const [error, setError] = useState<string | null>(null)

  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [coverPaperId, setCoverPaperId] = useState<number | null>(null)
  const [inners, setInners] = useState<InnerSection[]>([newInner()])
  const [bindingId, setBindingId] = useState<number | null>(null)
  const [addonIds, setAddonIds] = useState<Set<number>>(new Set())
  const [count, setCount] = useState(50)
  const [quote, setQuote] = useState<BookSpecQuoteDto | null>(null)
  const [qstate, setQstate] = useState<QState>('idle')

  useEffect(() => {
    fetchBookConfig()
      .then(setCfg)
      .catch(() => { if (!getBookConfigCache()) setError('书册配置加载失败') })
  }, [])

  const papers = cfg?.papers ?? []
  const sizes = cfg?.sizes ?? []
  const bindings = cfg?.finishings.binding ?? []
  const addons = cfg?.finishings.addons ?? []

  const coverPapers = useMemo(() => {
    if (!sizeKey) return []
    return papers.filter((p) =>
      p.available_sizes.includes(sizeKey) &&
      p.color_classes.some((cc) => cc === 'color' || cc === 'bw'),
    )
  }, [papers, sizeKey])

  const innerPapers = useMemo(() => {
    if (!sizeKey) return []
    return papers.filter((p) => p.available_sizes.includes(sizeKey))
  }, [papers, sizeKey])

  const paperName = (id: number) => papers.find((p) => p.id === id)?.name ?? `纸 ${id}`

  const canPrint = (paper: BookConfigPaper, cc: string) => paper.color_classes.includes(cc)

  const updateInner = (idx: number, patch: Partial<InnerSection>) => {
    setInners((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }

  const removeInner = (idx: number) => {
    setInners((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
  }

  const allReady = sizeKey && coverPaperId && inners.every((s) => s.paper_id && s.sheets >= 1)
  const finishingIds = useMemo(() => {
    const ids: number[] = []
    if (bindingId) ids.push(bindingId)
    for (const id of addonIds) ids.push(id)
    return ids.sort()
  }, [bindingId, addonIds])

  const specKey = useMemo(() => {
    if (!allReady) return null
    const comps = [
      { role: 'cover' as const, paper_id: coverPaperId!, color_class: 'color', duplex: 0, sheets_per_book: 1 },
      ...inners.filter((s) => s.paper_id).map((s) => ({
        role: 'inner' as const,
        paper_id: s.paper_id!,
        color_class: s.color_class,
        duplex: s.duplex,
        sheets_per_book: s.sheets,
      })),
    ]
    return JSON.stringify({ count, size_key: sizeKey, components: comps, finishing_ids: finishingIds })
  }, [allReady, coverPaperId, inners, sizeKey, count, finishingIds])

  useEffect(() => {
    setQuote(null)
    if (!specKey) { setQstate('idle'); return }
    setQstate('loading')
    let aborted = false
    const body = JSON.parse(specKey) as Parameters<typeof fetchBookSpecQuote>[0]
    fetchBookSpecQuote(body)
      .then((res) => {
        if (aborted) return
        if (res.ok) { setQuote(res.data); setQstate('ready') }
        else setQstate('unavailable')
      })
      .catch(() => { if (!aborted) setQstate('error') })
    return () => { aborted = true }
  }, [specKey])

  const add = () => {
    if (!quote || !sizeKey || !coverPaperId) return
    const comps: BookCartLine['components'] = [
      { role: 'cover', paper_id: coverPaperId, color_class: 'color', duplex: 0, sheets_per_book: 1 },
      ...inners.filter((s) => s.paper_id).map((s) => ({
        role: 'inner' as const,
        paper_id: s.paper_id!,
        color_class: s.color_class,
        duplex: s.duplex,
        sheets_per_book: s.sheets,
      })),
    ]
    const sLabel = sizes.find((s) => s.key === sizeKey)?.label ?? sizeKey
    const innerDesc = inners.filter((s) => s.paper_id).map((s) =>
      `${COLOR_LABEL[s.color_class]}${s.sheets}张`,
    ).join('+')
    onAdd({
      kind: 'book',
      count,
      size_key: sizeKey,
      components: comps,
      finishing_ids: finishingIds,
      label: `自定义书册 · ${sLabel} · ${innerDesc} · ${count}本`,
      line_total_display: quote.line_total_display,
    })
  }

  if (error) return <p className="text-[14px] text-wine-ink">{error}</p>
  if (!cfg) return <p className="text-[13px] text-dim">书册配置加载中…</p>

  const pillBtn = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-[12.5px] transition-opacity ${
      active ? 'border-wine bg-wine text-cream' : 'border-line text-dim hover:text-ink'
    }`

  return (
    <div className="space-y-5">
      {/* ① 尺寸 */}
      <Field label="尺寸">
        <select
          className={specInput}
          value={sizeKey ?? ''}
          onChange={(e) => {
            const v = e.target.value || null
            setSizeKey(v)
            setCoverPaperId(null)
            setInners([newInner()])
          }}
        >
          <option value="">— 选择 —</option>
          {sizes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </Field>

      {sizeKey && (
        <>
          {/* ② 封面纸 */}
          <Field label="封面用纸（彩色·1张/本）">
            <select
              className={specInput}
              value={coverPaperId ?? ''}
              onChange={(e) => setCoverPaperId(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">— 选择 —</option>
              {coverPapers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.gsm ? ` ${p.gsm}g` : ''}</option>
              ))}
            </select>
          </Field>

          {/* ③ 内页 */}
          {inners.map((s, idx) => {
            const availPapers = innerPapers.filter((p) => canPrint(p, s.color_class))
            return (
              <div key={idx} className="space-y-3 border-t border-line pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium tracking-[.06em] text-dim">
                    内页{inners.length > 1 ? ` ${idx + 1}` : ''}
                  </span>
                  {inners.length > 1 && (
                    <button type="button" className="font-mono text-[11px] text-dim hover:text-wine-ink" onClick={() => removeInner(idx)}>
                      移除 ✕
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  <button type="button" className={pillBtn(s.color_class === 'bw')} onClick={() => updateInner(idx, { color_class: 'bw', paper_id: null })}>黑白</button>
                  <button type="button" className={pillBtn(s.color_class === 'color')} onClick={() => updateInner(idx, { color_class: 'color', paper_id: null })}>彩色</button>
                </div>
                <Field label="纸张">
                  <select
                    className={specInput}
                    value={s.paper_id ?? ''}
                    onChange={(e) => updateInner(idx, { paper_id: e.target.value === '' ? null : Number(e.target.value) })}
                  >
                    <option value="">— 选择 —</option>
                    {availPapers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}{p.gsm ? ` ${p.gsm}g` : ''}</option>
                    ))}
                  </select>
                </Field>
                <div className="flex gap-2">
                  <button type="button" className={pillBtn(s.duplex === 0)} onClick={() => updateInner(idx, { duplex: 0 })}>单面</button>
                  <button type="button" className={pillBtn(s.duplex === 1)} onClick={() => updateInner(idx, { duplex: 1 })}>双面</button>
                </div>
                <Field label="每本张数">
                  <input
                    type="number"
                    min={1}
                    className={specInput}
                    value={s.sheets}
                    onChange={(e) => updateInner(idx, { sheets: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
                  />
                </Field>
              </div>
            )
          })}
          <button
            type="button"
            className="w-full rounded-full border border-dashed border-line px-3 py-2 text-[12.5px] text-dim hover:border-ink hover:text-ink"
            onClick={() => setInners((prev) => [...prev, newInner()])}
          >
            + 添加另一种内页
          </button>

          {/* ④ 装订 */}
          {bindings.length > 0 && (
            <div className="border-t border-line pt-4">
              <span className="block pb-2 text-[11px] font-medium tracking-[.06em] text-dim">装订方式</span>
              <div className="flex flex-wrap gap-2">
                {bindings.map((b) => (
                  <button key={b.id} type="button" className={pillBtn(bindingId === b.id)} onClick={() => setBindingId(bindingId === b.id ? null : b.id)}>
                    {b.name}
                    <span className="ml-1 text-[10.5px] opacity-60">{b.price_display}/本</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ⑤ 工艺加选 */}
          {addons.length > 0 && (
            <div className="pt-1">
              <span className="block pb-1.5 text-[11px] font-medium tracking-[.06em] text-dim">工艺（可选）</span>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {addons.map((f) => (
                  <label key={f.id} className="flex items-center gap-1.5 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={addonIds.has(f.id)}
                      onChange={() => setAddonIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(f.id)) next.delete(f.id); else next.add(f.id)
                        return next
                      })}
                    />
                    {f.name}
                    <span className="text-[11px] text-dim">({f.price_display})</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* ⑥ 本数 */}
          <Field label="本数">
            <input
              type="number"
              min={1}
              className={specInput}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
            />
          </Field>

          {/* ⑦ 报价 + 加入清单 */}
          <div className="border-t border-line pt-4">
            {qstate === 'ready' && quote ? (
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-dim">
                  {quote.unit_display}/本 × {count}
                </span>
                <span className="text-[22px] font-semibold text-wine-ink">{quote.line_total_display}</span>
              </div>
            ) : (
              <p className="text-[12.5px] text-dim">
                {qstate === 'loading'
                  ? '计算中…'
                  : qstate === 'unavailable'
                    ? '该配置暂不可报价（某组件无可用纸/尺寸组合）。'
                    : qstate === 'error'
                      ? '报价服务暂时不可用。'
                      : '选齐封面、内页纸张后显示报价。'}
              </p>
            )}
            <button
              type="button"
              disabled={qstate !== 'ready'}
              onClick={add}
              className="mt-3 w-full rounded-full border border-wine px-[18px] py-2.5 text-[14px] font-medium text-wine-ink transition-opacity hover:opacity-80 disabled:border-line disabled:text-dim"
            >
              加入订单清单 ↓
            </button>
          </div>
        </>
      )}
    </div>
  )
}
