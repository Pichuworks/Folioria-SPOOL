import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import {
  createGuestOrder,
  createOrder,
  fetchBookQuote,
  fetchBooks,
  fetchMe,
  fetchProducts,
  fetchPublicConfig,
  fetchQuote,
  getMeCache,
  getProductsCache,
  getPublicConfigCache,
  takeReorder,
  type MeDto,
  type ProductDto,
  type ProductsDto,
  type QuoteDto,
} from './api'
import { type BookCartLine } from './BookConfigurator'
const BookConfigurator = lazy(() => import('./BookConfigurator'))
import { VerifyBanner } from './CustomerGate'
import CustomerGate from './CustomerGate'
import { Field, Leader, MagSec, specInput } from './spec'

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

/** 登录门过门回跳：在 effect 中回写状态，避免渲染期 setState */
function GateReturn({ me, onReady }: { me: MeDto; onReady: (m: MeDto) => void }) {
  useEffect(() => {
    onReady(me)
  }, [me, onReady])
  return <p className="pt-13 text-[14px] text-dim">登录成功，返回订单清单…</p>
}

interface ItemCartLine {
  kind: 'item'
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  label: string
  unit_display: string
  line_total_display: string
}
/** 购物车一行 = 单页 item 或 D27 书行 */
type CartLine = ItemCartLine | BookCartLine

/** ③⑤ #/quote：按属性（类别/纸/尺寸/双面/技术 或 照片品质档）选,机器对客户不可见 */
export default function Quote() {
  const [data, setData] = useState<ProductsDto | null>(getProductsCache)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'single' | 'book'>('single')
  const [category, setCategory] = useState<'bw' | 'color' | 'photo' | null>(null)
  const [grade, setGrade] = useState<string | null>(null)
  const [tech, setTech] = useState<string | null>(null)
  const [duplex, setDuplex] = useState<boolean | null>(null)
  const [paperId, setPaperId] = useState<number | null>(null)
  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(100)
  const [quote, setQuote] = useState<QuoteDto | null>(null)
  const [quoteState, setQuoteState] = useState<QuoteState>('idle')
  const [cart, setCart] = useState<CartLine[]>([])
  const [contact, setContact] = useState('')
  const [notes, setNotes] = useState('')
  const [deliveryMethod, setDeliveryMethod] = useState<'pickup' | 'shipping'>('pickup')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [needLogin, setNeedLogin] = useState(false)
  const [reorderNotice, setReorderNotice] = useState<string | null>(null)
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)
  const [guestOpen, setGuestOpen] = useState(() => getPublicConfigCache()?.guest_orders_open ?? false)
  const [guestEmail, setGuestEmail] = useState('')
  const [guestName, setGuestName] = useState('')

  useEffect(() => {
    fetchProducts()
      .then(setData)
      .catch(() => {
        if (!getProductsCache()) setError('价目数据加载失败')
      })
    fetchMe().then(setMe).catch(() => setMe(null))
    fetchPublicConfig().then((c) => setGuestOpen(c.guest_orders_open)).catch(() => {})
  }, [])

  // C1/D32 一键再下单：消费缓冲的单页行 + 册子行，按现价重报后填入购物车；
  // 册子行对照实时目录——成品或任一组件已归档则跳过并提示
  useEffect(() => {
    const buf = takeReorder()
    if (!buf || (buf.items.length === 0 && buf.books.length === 0)) return
    let cancelled = false
    void (async () => {
      const lines: CartLine[] = []
      let skipped = 0
      for (const it of buf.items) {
        const q = await fetchQuote({ mode_id: it.mode_id, paper_id: it.paper_id, size_key: it.size_key, quantity: it.quantity }).catch(() => null)
        if (q) {
          lines.push({
            kind: 'item',
            mode_id: it.mode_id,
            paper_id: it.paper_id,
            size_key: it.size_key,
            quantity: it.quantity,
            label: it.label,
            unit_display: q.unit_display,
            line_total_display: q.line_total_display,
          })
        } else skipped += 1
      }
      if (buf.books.length > 0) {
        const catalog = await fetchBooks().catch(() => null)
        for (const rb of buf.books) {
          // 成品下架 → 目录无此 book；组件下架 → 目录组件集合缺 source_component_id
          const cat = catalog?.books.find((b) => b.id === rb.book_id)
          const catIds = new Set(cat?.components.map((c) => c.id))
          if (!cat || rb.components.some((c) => !catIds.has(c.component_id))) {
            skipped += 1
            continue
          }
          const res = await fetchBookQuote({ book_id: rb.book_id, count: rb.count, components: rb.components }).catch(() => null)
          if (res && res.ok) {
            lines.push({
              kind: 'book',
              book_id: rb.book_id,
              count: rb.count,
              components: rb.components,
              label: `${cat.name} · ${rb.count}本`,
              line_total_display: res.data.line_total_display,
            })
          } else skipped += 1
        }
      }
      if (cancelled) return
      if (lines.length > 0) setCart((prev) => [...prev, ...lines])
      if (skipped > 0) setReorderNotice(`${skipped} 项因成品/组件已下架或暂不可报价，已跳过——请确认清单。`)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const products = useMemo(() => data?.products ?? [], [data])
  const paperName = (id: number) => data?.papers.find((p) => p.id === id)?.name ?? `纸 ${id}`
  const sizeLabel = (k: string) => data?.sizes.find((s) => s.key === k)?.label ?? k

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
    return (data?.papers ?? []).filter((p) => ids.has(p.id))
  }, [pool, data])
  const afterPaper = useMemo(() => pool.filter((p) => paperId == null || p.paper_id === paperId), [pool, paperId])
  const sizes = useMemo(() => {
    const keys = new Set(afterPaper.map((p) => p.size_key))
    return (data?.sizes ?? []).filter((s) => keys.has(s.key)).sort((a, b) => a.sort - b.sort)
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

  useEffect(() => {
    setQuote(null)
    if (!resolved || quantity < 1) {
      setQuoteState('idle')
      return
    }
    setQuoteState('loading')
    const ctl = new AbortController()
    fetchQuote({ mode_id: resolved.mode_id, paper_id: resolved.paper_id, size_key: resolved.size_key, quantity })
      .then((q) => {
        if (ctl.signal.aborted) return
        setQuote(q)
        setQuoteState(q ? 'ready' : 'unavailable')
      })
      .catch(() => {
        if (!ctl.signal.aborted) setQuoteState('error')
      })
    return () => ctl.abort()
  }, [resolved, quantity])

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
    setCart((prev) => [
      ...prev,
      {
        kind: 'item',
        mode_id: resolved.mode_id,
        paper_id: resolved.paper_id,
        size_key: resolved.size_key,
        quantity: quote.quantity,
        label,
        unit_display: quote.unit_display,
        line_total_display: quote.line_total_display,
      },
    ])
  }

  const items = () =>
    cart
      .filter((l): l is ItemCartLine => l.kind === 'item')
      .map(({ mode_id, paper_id, size_key, quantity: qty }) => ({ mode_id, paper_id, size_key, quantity: qty }))
  const books = () =>
    cart
      .filter((l): l is BookCartLine => l.kind === 'book')
      .map(({ book_id, count, components }) => ({ book_id, count, components }))

  const showError = (err: string | undefined, status: number) =>
    setSubmitError(
      err === 'email_unverified'
        ? '邮箱尚未验证——请先打开注册邮件中的验证链接。'
        : err === 'guest_orders_closed'
          ? '当前未开放访客下单，请登录后提交。'
          : err?.includes('not_quotable')
            ? '清单中存在已失效的组合，请移除后重试。'
            : `提交失败（${err ?? status}）`,
    )

  const delivery = () => ({
    delivery_method: deliveryMethod,
    delivery_address: deliveryMethod === 'shipping' ? deliveryAddress.trim() : null,
  })

  const submit = async () => {
    if (cart.length === 0) return
    if (deliveryMethod === 'shipping' && deliveryAddress.trim() === '') {
      setSubmitError('选择邮寄请填写收件地址。')
      return
    }
    if (!me) {
      if (!guestOpen) {
        setNeedLogin(true)
        return
      }
      if (guestEmail.trim() === '' || guestName.trim() === '') {
        setSubmitError('请填写邮箱与称呼以访客下单（或登录/注册后提交）。')
        return
      }
      setSubmitting(true)
      setSubmitError(null)
      const gres = await createGuestOrder({
        items: items(),
        books: books(),
        ...delivery(),
        email: guestEmail.trim(),
        name: guestName.trim(),
        contact_info: contact.trim() === '' ? null : contact.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
      })
      setSubmitting(false)
      if (gres.ok) {
        window.location.hash = `#/order/${gres.data.access_token}`
        return
      }
      showError((gres.data as { error?: string })?.error, gres.status)
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    const res = await createOrder({
      items: items(),
      books: books(),
      ...delivery(),
      contact_info: contact.trim() === '' ? null : contact.trim(),
      notes: notes.trim() === '' ? null : notes.trim(),
    })
    setSubmitting(false)
    if (res.ok) {
      window.location.hash = `#/order/${res.data.access_token}`
      return
    }
    showError((res.data as { error?: string })?.error, res.status)
  }

  if (error) return <p className="pt-13 text-[14px] text-wine-ink">{error}</p>
  if (!data) return <p className="pt-13 text-[14px] text-dim">价目加载中…</p>

  if (needLogin && !me) {
    return (
      <CustomerGate>
        {(gateMe) => (
          <GateReturn
            me={gateMe}
            onReady={(m) => {
              setMe(m)
              setNeedLogin(false)
            }}
          />
        )}
      </CustomerGate>
    )
  }

  const catBtn = (active: boolean) =>
    `flex-1 rounded-full border px-3 py-2 text-[13.5px] transition-opacity ${
      active ? 'border-wine bg-wine text-cream' : 'border-line text-dim hover:text-ink'
    }`

  return (
    <MagSec title="自助报价 · 在线下单">
      {me && <VerifyBanner me={me} />}
      <div className="mt-2 grid grid-cols-1 border border-ink md:grid-cols-[5fr_7fr]">
        {/* 左栏：单页属性配置器 / 册子配置器 */}
        <div className="space-y-5 border-b border-ink p-7 md:border-b-0 md:border-r">
          <div className="flex gap-2">
            <button type="button" className={catBtn(mode === 'single')} onClick={() => setMode('single')}>
              单页
            </button>
            <button type="button" className={catBtn(mode === 'book')} onClick={() => setMode('book')}>
              册子
            </button>
          </div>
          {mode === 'book' ? (
            <Suspense fallback={<div className="py-8 text-center text-dim text-[13px]">载入中…</div>}>
              <BookConfigurator onAdd={(line) => setCart((prev) => [...prev, line])} />
            </Suspense>
          ) : (
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
                      : '选齐属性后显示报价。'}
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
          )}
        </div>

        {/* 右栏：清单与提交 */}
        <div className="flex flex-col p-7">
          <div className="font-mono text-[10px] tracking-[.14em] text-dim">清单 · {cart.length}</div>
          {reorderNotice && (
            <p className="mt-2 border border-warn bg-warn/10 px-3 py-2 text-[12px] text-warn">{reorderNotice}</p>
          )}
          {cart.length === 0 ? (
            <p className="flex-1 py-12 text-[13px] text-dim">清单为空</p>
          ) : (
            <div className="mt-3 flex-1">
              {cart.map((line, idx) => (
                <div key={idx} className="flex items-baseline gap-3 border-b border-line py-[10px]">
                  <span className="text-[13.5px] font-medium text-ink">{line.label}</span>
                  {line.kind === 'item' && (
                    <span className="text-[12px] text-dim">
                      {line.unit_display}/张 × {line.quantity}
                    </span>
                  )}
                  <Leader />
                  <span className="font-mono text-[13px] text-wine-ink">{line.line_total_display}</span>
                  <button
                    type="button"
                    className="font-mono text-[11px] text-dim hover:text-wine-ink"
                    onClick={() => setCart((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 space-y-4 border-t-2 border-ink pt-5">
            {!me && guestOpen && (
              <>
                <Field label="邮箱">
                  <input type="email" className={specInput} value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} />
                </Field>
                <Field label="称呼">
                  <input maxLength={80} className={specInput} value={guestName} onChange={(e) => setGuestName(e.target.value)} />
                </Field>
              </>
            )}
            <Field label="配送方式">
              <select
                className={specInput}
                value={deliveryMethod}
                onChange={(e) => setDeliveryMethod(e.target.value as 'pickup' | 'shipping')}
              >
                <option value="pickup">到店自取</option>
                <option value="shipping">邮寄</option>
              </select>
            </Field>
            {deliveryMethod === 'shipping' && (
              <Field label="收件地址">
                <textarea
                  className={specInput}
                  rows={2}
                  maxLength={500}
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                />
              </Field>
            )}
            <Field label="联系方式">
              <input className={specInput} maxLength={200} value={contact} onChange={(e) => setContact(e.target.value)} />
            </Field>
            <Field label="备注">
              <input className={specInput} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            {submitError && <p className="text-[13px] text-wine-ink">{submitError}</p>}
            <button
              type="button"
              disabled={cart.length === 0 || submitting}
              onClick={() => void submit()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-wine bg-wine px-[18px] py-2.5 text-[14px] font-medium tracking-[.02em] text-cream shadow-e1 transition-opacity hover:opacity-90 disabled:border-line disabled:bg-deep disabled:text-dim"
            >
              {submitting ? '提交中…' : me ? '提交订单 →' : guestOpen ? '以访客提交订单 →' : '登录并提交订单 →'}
            </button>
          </div>
        </div>
      </div>
    </MagSec>
  )
}
