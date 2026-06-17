import { lazy, Suspense, useEffect, useState } from 'react'
import {
  createGuestOrder,
  createOrder,
  fetchBookSpecQuote,
  fetchProducts,
  fetchPublicConfig,
  fetchQuote,
  getProductsCache,
  getPublicConfigCache,
  takeReorder,
  type ProductsDto,
} from './api'
import { useAuth } from './AuthContext'
import type { BookCartLine } from './BookConfigurator'
const BookConfigurator = lazy(() => import('./BookConfigurator'))
import { VerifyBanner } from './CustomerGate'
import CustomerGate from './CustomerGate'
import QuoteSelector, { type ItemCartLine } from './QuoteSelector'
import { Field, Leader, MagSec, specInput } from './spec'

function GateReturn({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    onReady()
  }, [onReady])
  return <p className="pt-13 text-[14px] text-dim">登录成功，返回订单清单…</p>
}

type CartLine = ItemCartLine | BookCartLine

export default function Quote() {
  const [data, setData] = useState<ProductsDto | null>(getProductsCache)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'single' | 'book'>('single')
  const [cart, setCart] = useState<CartLine[]>([])
  const [contact, setContact] = useState('')
  const [notes, setNotes] = useState('')
  const [deliveryMethod, setDeliveryMethod] = useState<'pickup' | 'shipping'>('pickup')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [needLogin, setNeedLogin] = useState(false)
  const [reorderNotice, setReorderNotice] = useState<string | null>(null)
  const me = useAuth()
  const [guestOpen, setGuestOpen] = useState(() => getPublicConfigCache()?.guest_orders_open ?? false)
  const [guestEmail, setGuestEmail] = useState('')
  const [guestName, setGuestName] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchProducts()
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled && !getProductsCache()) setError('价目数据加载失败') })
    fetchPublicConfig().then((c) => { if (!cancelled) setGuestOpen(c.guest_orders_open) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

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
            finishing_ids: [],
            label: it.label,
            unit_display: q.unit_display,
            line_total_display: q.line_total_display,
          })
        } else skipped += 1
      }
      for (const rb of buf.books) {
        const res = await fetchBookSpecQuote({
          count: rb.count,
          size_key: rb.size_key,
          components: rb.components,
          finishing_ids: rb.finishing_ids,
        }).catch(() => null)
        if (res && res.ok) {
          lines.push({
            kind: 'book',
            count: rb.count,
            size_key: rb.size_key,
            components: rb.components,
            finishing_ids: rb.finishing_ids,
            label: rb.label,
            line_total_display: res.data.line_total_display,
          })
        } else skipped += 1
      }
      if (cancelled) return
      if (lines.length > 0) setCart((prev) => [...prev, ...lines])
      if (skipped > 0) setReorderNotice(`${skipped} 项因组件已下架或暂不可报价，已跳过——请确认清单。`)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const items = () =>
    cart
      .filter((l): l is ItemCartLine => l.kind === 'item')
      .map(({ mode_id, paper_id, size_key, quantity: qty, finishing_ids: fids }) => ({
        mode_id, paper_id, size_key, quantity: qty,
        ...(fids.length > 0 ? { finishing_ids: fids } : {}),
      }))
  const customBooks = () =>
    cart
      .filter((l): l is BookCartLine => l.kind === 'book')
      .map(({ count, size_key, components, finishing_ids }) => ({
        count, size_key, components,
        ...(finishing_ids.length > 0 ? { finishing_ids } : {}),
      }))

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
        custom_books: customBooks(),
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
      custom_books: customBooks(),
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
        {() => (
          <GateReturn
            onReady={() => setNeedLogin(false)}
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
        <div className="space-y-5 border-b border-ink p-7 md:border-b-0 md:border-r">
          <div className="flex gap-2">
            <button type="button" className={catBtn(mode === 'single')} onClick={() => setMode('single')}>
              单页
            </button>
            <button type="button" className={catBtn(mode === 'book')} onClick={() => setMode('book')}>
              书册
            </button>
          </div>
          {mode === 'book' ? (
            <Suspense fallback={<div className="py-8 text-center text-dim text-[13px]">载入中…</div>}>
              <BookConfigurator onAdd={(line) => setCart((prev) => [...prev, line])} />
            </Suspense>
          ) : (
            <QuoteSelector data={data} onAdd={(line) => setCart((prev) => [...prev, line])} />
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
