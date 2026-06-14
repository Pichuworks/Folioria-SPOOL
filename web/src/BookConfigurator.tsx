import { useEffect, useMemo, useState } from 'react'
import {
  fetchBookQuote,
  fetchBooks,
  getBooksCache,
  type BookCatalogItemDto,
  type BookQuoteDto,
  type BooksCatalogDto,
} from './api'
import { Field, Leader, specInput } from './spec'

export interface BookCartLine {
  kind: 'book'
  book_id: number
  count: number
  components: Array<{ component_id: number; sheets_per_book: number }>
  label: string
  line_total_display: string
}

const ROLE_LABEL: Record<string, string> = { cover: '封面', inner: '内页', insert: '插图' }
const COLOR_LABEL: Record<string, string> = {
  bw: '黑白',
  color: '彩色',
  'photo-value': '照片·性价比',
  'photo-premium': '照片·高质量',
  'photo-art': '照片·艺术微喷',
}
const PRICING_LABEL: Record<string, string> = { per_book: '按本', per_page: '按页', per_area: '按面积' }

type QState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

/** ③⑤/D27 册子配置器：选成品 → 填内页/插图张数 + 本数 → 实时出价（机器对客户不可见）。 */
export default function BookConfigurator({ onAdd }: { onAdd: (line: BookCartLine) => void }) {
  const [data, setData] = useState<BooksCatalogDto | null>(getBooksCache)
  const [error, setError] = useState<string | null>(null)
  const [bookId, setBookId] = useState<number | null>(null)
  const [count, setCount] = useState(50)
  const [sheets, setSheets] = useState<Record<number, number>>({})
  const [quote, setQuote] = useState<BookQuoteDto | null>(null)
  const [qstate, setQstate] = useState<QState>('idle')

  useEffect(() => {
    fetchBooks()
      .then(setData)
      .catch(() => {
        if (!getBooksCache()) setError('册子目录加载失败')
      })
  }, [])

  const book: BookCatalogItemDto | null = useMemo(
    () => data?.books.find((b) => b.id === bookId) ?? null,
    [data, bookId],
  )

  // 选定成品时初始化每组件张数：封面固定 1（不取输入），内页默认 10，插图默认 0（不含）
  const selectBook = (id: number | null) => {
    setBookId(id)
    setQuote(null)
    setQstate('idle')
    const b = data?.books.find((x) => x.id === id)
    if (!b) {
      setSheets({})
      return
    }
    const init: Record<number, number> = {}
    for (const c of b.components) {
      if (c.role === 'inner') init[c.id] = 10
      else if (c.role === 'insert') init[c.id] = 0
    }
    setSheets(init)
  }

  // 客户填的组件张数（内页/插图，封面不计）；插图 0 = 不含
  const orderComponents = useMemo(() => {
    if (!book) return []
    const out: Array<{ component_id: number; sheets_per_book: number }> = []
    for (const c of book.components) {
      if (c.role === 'cover') continue
      const n = sheets[c.id] ?? 0
      if (c.role === 'inner') {
        if (n >= 1) out.push({ component_id: c.id, sheets_per_book: n })
      } else if (n >= 1) {
        out.push({ component_id: c.id, sheets_per_book: n })
      }
    }
    return out
  }, [book, sheets])

  // 所有内页都已填（≥1）才报价
  const innerReady = useMemo(
    () => !!book && book.components.filter((c) => c.role === 'inner').every((c) => (sheets[c.id] ?? 0) >= 1),
    [book, sheets],
  )

  useEffect(() => {
    setQuote(null)
    if (!book || count < 1 || !innerReady) {
      setQstate('idle')
      return
    }
    setQstate('loading')
    let aborted = false
    fetchBookQuote({ book_id: book.id, count, components: orderComponents })
      .then((res) => {
        if (aborted) return
        if (res.ok) {
          setQuote(res.data)
          setQstate('ready')
        } else {
          setQstate('unavailable')
        }
      })
      .catch(() => {
        if (!aborted) setQstate('error')
      })
    return () => {
      aborted = true
    }
  }, [book, count, innerReady, orderComponents])

  const add = () => {
    if (!quote || !book) return
    onAdd({
      kind: 'book',
      book_id: book.id,
      count,
      components: orderComponents,
      label: `${book.name} · ${count}本`,
      line_total_display: quote.line_total_display,
    })
  }

  if (error) return <p className="text-[14px] text-wine-ink">{error}</p>
  if (!data) return <p className="text-[13px] text-dim">册子目录加载中…</p>
  if (data.books.length === 0)
    return <p className="text-[13px] leading-[1.85] text-dim">暂无册子成品——请联系工坊配置，或选「单页」自助下单。</p>

  return (
    <div className="space-y-5">
      <div className="font-mono text-[10px] tracking-[.14em] text-dim">做哪种册子</div>

      <Field label="成品">
        <select
          className={specInput}
          value={bookId ?? ''}
          onChange={(e) => selectBook(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">— 选择 —</option>
          {data.books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>

      {book && (
        <>
          <div className="space-y-3 border-t border-line pt-4">
            {book.components.map((c) => {
              const spec = `${COLOR_LABEL[c.color_class] ?? c.color_class} · ${c.paper_name} · ${c.size_label}${c.duplex ? ' · 双面' : ''}`
              if (c.role === 'cover') {
                return (
                  <div key={c.id} className="flex items-baseline gap-3">
                    <span className="min-w-14 text-[13px] font-medium text-ink">封面</span>
                    <span className="text-[12.5px] text-dim">{spec}</span>
                    <Leader />
                    <span className="font-mono text-[12px] text-dim">1 张/本</span>
                  </div>
                )
              }
              return (
                <Field key={c.id} label={`${ROLE_LABEL[c.role] ?? c.role} · ${spec}（每本张数${c.role === 'insert' ? '，0=不含' : ''}）`}>
                  <input
                    type="number"
                    min={c.role === 'insert' ? 0 : 1}
                    className={specInput}
                    value={sheets[c.id] ?? 0}
                    onChange={(e) =>
                      setSheets((prev) => ({ ...prev, [c.id]: Math.max(0, Math.trunc(Number(e.target.value) || 0)) }))
                    }
                  />
                </Field>
              )
            })}
          </div>

          {book.finishings.length > 0 && (
            <p className="text-[11.5px] leading-[1.7] text-dim">
              含工艺：{book.finishings.map((f) => `${f.name}（${PRICING_LABEL[f.pricing] ?? f.pricing} ${f.price_display}）`).join('、')}
            </p>
          )}

          <Field label="本数">
            <input
              type="number"
              min={1}
              className={specInput}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
            />
          </Field>

          <div className="border-t border-line pt-4">
            {qstate === 'ready' && quote ? (
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-dim">
                  {quote.unit_display}/本 × {quote.count}
                </span>
                <span className="text-[22px] font-semibold text-wine-ink">{quote.line_total_display}</span>
              </div>
            ) : (
              <p className="text-[12.5px] text-dim">
                {qstate === 'loading'
                  ? '计算中…'
                  : qstate === 'unavailable'
                    ? '该配置暂不可报价（某组件无可用纸/尺寸）。'
                    : qstate === 'error'
                      ? '报价服务暂时不可用。'
                      : '填齐内页张数后显示报价。'}
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
