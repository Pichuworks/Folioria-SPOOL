import { useEffect, useMemo, useState } from 'react'
import {
  createGuestOrder,
  createOrder,
  fetchMe,
  fetchOptions,
  fetchPublicConfig,
  fetchQuote,
  getMeCache,
  getOptionsCache,
  getPublicConfigCache,
  type MeDto,
  type OptionsDto,
  type QuoteDto,
} from './api'
import { VerifyBanner } from './CustomerGate'
import CustomerGate from './CustomerGate'
import { Field, Leader, MagSec, PillBtn, specInput } from './spec'

type QuoteState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

/** 登录门过门回跳：在 effect 中回写状态，避免渲染期 setState */
function GateReturn({ me, onReady }: { me: MeDto; onReady: (m: MeDto) => void }) {
  useEffect(() => {
    onReady(me)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <p className="pt-13 text-[14px] text-dim">登录成功，返回订单清单…</p>
}

interface CartLine {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  label: string
  unit_display: string
  line_total_display: string
}

/** R8 #/quote：公开配置器 + 多行购物车；提交即下单（登录/注册门 + 邮箱验证门） */
export default function Quote() {
  const [options, setOptions] = useState<OptionsDto | null>(getOptionsCache)
  const [error, setError] = useState<string | null>(null)
  const [modeId, setModeId] = useState<number | null>(null)
  const [paperId, setPaperId] = useState<number | null>(null)
  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(100)
  const [quote, setQuote] = useState<QuoteDto | null>(null)
  const [quoteState, setQuoteState] = useState<QuoteState>('idle')
  const [cart, setCart] = useState<CartLine[]>([])
  const [contact, setContact] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [needLogin, setNeedLogin] = useState(false)
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)
  const [guestOpen, setGuestOpen] = useState(() => getPublicConfigCache()?.guest_orders_open ?? false)
  const [guestEmail, setGuestEmail] = useState('')
  const [guestName, setGuestName] = useState('')

  useEffect(() => {
    fetchOptions()
      .then(setOptions)
      .catch(() => {
        if (!getOptionsCache()) setError('价目数据加载失败')
      })
    fetchMe().then(setMe).catch(() => setMe(null))
    fetchPublicConfig().then((c) => setGuestOpen(c.guest_orders_open)).catch(() => {})
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

  const addToCart = () => {
    if (!quote || !options) return
    const modeName = options.modes.find((m) => m.id === quote.mode_id)?.name ?? `模式 ${quote.mode_id}`
    const paperName = options.papers.find((p) => p.id === quote.paper_id)?.name ?? `纸 ${quote.paper_id}`
    const sizeLabel = options.sizes.find((s) => s.key === quote.size_key)?.label ?? quote.size_key
    setCart((prev) => [
      ...prev,
      {
        mode_id: quote.mode_id,
        paper_id: quote.paper_id,
        size_key: quote.size_key,
        quantity: quote.quantity,
        label: `${modeName} × ${paperName} · ${sizeLabel}`,
        unit_display: quote.unit_display,
        line_total_display: quote.line_total_display,
      },
    ])
  }

  const items = () =>
    cart.map(({ mode_id, paper_id, size_key, quantity: qty }) => ({ mode_id, paper_id, size_key, quantity: qty }))

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

  const submit = async () => {
    if (cart.length === 0) return
    if (!me) {
      // 未登录：开放访客下单则走访客通道（需邮箱+称呼），否则进登录门
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
  if (!options) return <p className="pt-13 text-[14px] text-dim">价目加载中…</p>

  if (needLogin && !me) {
    return (
      <CustomerGate>
        {(gateMe) => (
          <GateReturn
            me={gateMe}
            onReady={(m) => {
              // 过门即返回购物车（cart 状态保留在本组件）
              setMe(m)
              setNeedLogin(false)
            }}
          />
        )}
      </CustomerGate>
    )
  }

  return (
    <MagSec tag="下单" title="自助报价 · 在线下单" note="CONFIG → CART → ORDER">
      {me && <VerifyBanner me={me} />}
      <div className="mt-2 grid grid-cols-1 border border-ink md:grid-cols-[5fr_7fr]">
        {/* 左栏：配置器 */}
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
                      : '选定配置后显示报价。'}
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

        {/* 右栏：清单与提交 */}
        <div className="flex flex-col p-7">
          <div className="font-mono text-[10px] tracking-[.14em] text-dim">ORDER LINES · {cart.length}</div>
          {cart.length === 0 ? (
            <p className="flex-1 py-12 text-[13px] leading-[1.85] text-dim">
              清单为空——左侧配置后「加入订单清单」，可多行混排不同工艺与纸张。
            </p>
          ) : (
            <div className="mt-3 flex-1">
              {cart.map((line, idx) => (
                <div key={idx} className="flex items-baseline gap-3 border-b border-line py-[10px]">
                  <span className="text-[13.5px] font-medium text-ink">{line.label}</span>
                  <span className="text-[12px] text-dim">
                    {line.unit_display}/张 × {line.quantity}
                  </span>
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
              <p className="mt-2 text-right font-mono text-[10px] tracking-[.12em] text-dim">
                单行金额为预估快照 · 合计以提交后的订单为准
              </p>
            </div>
          )}

          <div className="mt-6 space-y-4 border-t-2 border-ink pt-5">
            {!me && guestOpen && (
              <>
                <p className="text-[11.5px] leading-[1.7] text-dim">
                  可免登录下单——提交后凭订单链接查看进度（请妥善保存）。也可
                  <a href="#/login" className="text-wine-ink hover:opacity-70"> 登录/注册 </a>
                  以便在「我的订单」统一管理。
                </p>
                <Field label="邮箱（接收订单状态通知）">
                  <input type="email" className={specInput} value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} />
                </Field>
                <Field label="称呼">
                  <input maxLength={80} className={specInput} value={guestName} onChange={(e) => setGuestName(e.target.value)} />
                </Field>
              </>
            )}
            <Field label="联系方式（取件/寄送沟通用，可留空）">
              <input className={specInput} maxLength={200} value={contact} onChange={(e) => setContact(e.target.value)} />
            </Field>
            <Field label="备注（可留空）">
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
            <p className="text-[11px] leading-[1.8] text-dim">
              提交后单价定格（改价不影响已建订单）；随后逐行上传印刷文件，审稿通过并确认后排产。
            </p>
          </div>
        </div>
      </div>
    </MagSec>
  )
}
