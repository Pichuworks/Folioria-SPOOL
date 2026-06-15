import { useCallback, useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import {
  fetchOrders,
  orderBookComponentFileUrl,
  ORDER_STATUS_LABEL,
  orderItemFileUrl,
  patchOrderDiscount,
  patchOrderStatus,
  recordPayment,
  reviewOrderBookComponent,
  reviewOrderItem,
  type OrderBookComponentDto,
  type OrderBookDto,
  type OrderDto,
  type OrderItemDto,
} from './api'
import { FILE_STATUS_LABEL, PrecheckNotes } from './OrderView'
import { Field, Leader, MagSec, SpecRow, specInput } from './spec'

/** §3.2 看板六列：报价中→审稿→已确认→生产中→待取→已完成（cancelled 折叠在下方） */
const COLUMNS: Array<{ label: string; statuses: Array<OrderDto['status']> }> = [
  { label: '报价中', statuses: ['quoted'] },
  { label: '审稿', statuses: ['file_pending', 'file_approved'] },
  { label: '已确认', statuses: ['confirmed'] },
  { label: '生产中', statuses: ['in_production'] },
  { label: '待取', statuses: ['ready'] },
  { label: '已完成', statuses: ['delivered'] },
]

/** 当前状态可执行的推进动作（confirm 走状态机校验：仅 file_approved 且未过期） */
const ACTIONS: Partial<Record<OrderDto['status'], Array<{ to: string; label: string }>>> = {
  file_approved: [{ to: 'confirmed', label: '确认下单 · 建作业' }],
  confirmed: [{ to: 'in_production', label: '开始生产' }],
  in_production: [{ to: 'ready', label: '完成 · 通知取件' }],
  ready: [{ to: 'delivered', label: '交付' }],
}

const PAY_LABEL = { unpaid: '未付', deposit: '定金', paid: '付清' } as const
const PAY_KIND_LABEL = { deposit: '押金', balance: '尾款', refund: '退款' } as const

function FilePreview({ url, kind }: { url: string; kind: string | undefined }) {
  const [open, setOpen] = useState(true)
  if (!kind || kind === 'tif' || kind === 'tiff') return null
  const src = `${url}?inline=1`
  return (
    <div className="mt-2">
      <button type="button" className="text-[11px] text-dim underline hover:text-ink" onClick={() => setOpen(!open)}>
        {open ? '收起预览' : '预览稿件'}
      </button>
      {open &&
        (kind === 'png' ? (
          <img src={src} alt="稿件预览" className="mt-2 max-h-[500px] max-w-full border border-line" />
        ) : kind === 'pdf' ? (
          <iframe src={src} title="稿件预览" className="mt-2 h-[600px] w-full border border-line" />
        ) : null)}
    </div>
  )
}

function ReviewRow({
  order,
  item,
  onUpdated,
}: {
  order: OrderDto
  item: OrderItemDto
  onUpdated: (o: OrderDto) => void
}) {
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const reviewable =
    item.has_file && ['quoted', 'file_pending', 'file_approved'].includes(order.status)

  const review = async (verdict: 'approved' | 'rejected') => {
    setErr(null)
    const res = await reviewOrderItem(order.id, item.id, verdict, verdict === 'rejected' ? note : undefined)
    if (res.ok) onUpdated(res.data)
    else setErr(`审稿失败（${res.status}）`)
  }

  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[13.5px] font-medium text-ink">
          {item.mode_name ?? item.category} × {item.paper_name} · {item.size_label}
        </span>
        <span className="text-[12px] text-dim">
          {item.unit_display}/张 × {item.quantity}
        </span>
        <Leader />
        <span className="font-mono text-[13px] text-wine-ink">{item.line_total_display}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
        {item.has_file ? (
          <a className="text-dim underline hover:text-ink" href={orderItemFileUrl(order.id, item.id)}>
            下载稿件
          </a>
        ) : (
          <span className="font-mono text-[10.5px] tracking-[.1em] text-dim">未上传</span>
        )}
        <span
          className={`font-mono text-[10.5px] tracking-[.1em] ${
            item.file_status === 'approved' ? 'text-ink' : item.file_status === 'rejected' ? 'text-warn' : 'text-dim'
          }`}
        >
          {FILE_STATUS_LABEL[item.file_status]}
        </span>
        {item.file_note && <span className="text-warn">意见：{item.file_note}</span>}
        {item.job_id && <span className="font-mono text-[10px] text-dim">JOB {item.job_id.slice(0, 8)}</span>}
        {reviewable && (
          <span className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-full border border-ink px-3 py-0.5 text-[12px] text-ink hover:bg-card"
              onClick={() => void review('approved')}
            >
              通过
            </button>
            <input
              placeholder="驳回意见"
              className="w-44 border border-line bg-card px-2 py-0.5 text-[12px] text-ink outline-none focus:border-wine"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              type="button"
              className="rounded-full border border-wine px-3 py-0.5 text-[12px] text-wine-ink hover:opacity-80"
              onClick={() => void review('rejected')}
            >
              驳回
            </button>
          </span>
        )}
        {err && <span className="text-wine-ink">{err}</span>}
      </div>
      {item.has_file && <PrecheckNotes precheck={item.file_precheck} />}
      {item.has_file && <FilePreview url={orderItemFileUrl(order.id, item.id)} kind={item.file_kind} />}
    </div>
  )
}

const BOOK_ROLE_LABEL: Record<string, string> = { cover: '封面', inner: '内页', insert: '插图' }

/** D31 书组件审稿行：与 ReviewRow 同口径，逐组件 approve/reject */
function BookComponentReviewRow({
  order,
  comp,
  onUpdated,
}: {
  order: OrderDto
  comp: OrderBookComponentDto
  onUpdated: (o: OrderDto) => void
}) {
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const reviewable = comp.has_file && ['quoted', 'file_pending', 'file_approved'].includes(order.status)

  const review = async (verdict: 'approved' | 'rejected') => {
    setErr(null)
    const res = await reviewOrderBookComponent(order.id, comp.id, verdict, verdict === 'rejected' ? note : undefined)
    if (res.ok) onUpdated(res.data)
    else setErr(`审稿失败（${res.status}）`)
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line py-1.5 pl-4 text-[12px] last:border-b-0">
      <span className="min-w-9 font-medium text-ink">{BOOK_ROLE_LABEL[comp.role] ?? comp.role}</span>
      <span className="text-dim">
        {comp.paper_name} · {comp.size_label}
      </span>
      {comp.has_file ? (
        <a className="text-dim underline hover:text-ink" href={orderBookComponentFileUrl(order.id, comp.id)}>
          下载稿件
        </a>
      ) : (
        <span className="font-mono text-[10px] tracking-[.1em] text-dim">未上传</span>
      )}
      <span
        className={`font-mono text-[10px] tracking-[.1em] ${
          comp.file_status === 'approved' ? 'text-ink' : comp.file_status === 'rejected' ? 'text-warn' : 'text-dim'
        }`}
      >
        {FILE_STATUS_LABEL[comp.file_status]}
      </span>
      {comp.file_note && <span className="text-warn">意见：{comp.file_note}</span>}
      {reviewable && (
        <span className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="rounded-full border border-ink px-2.5 py-0.5 text-[11.5px] text-ink hover:bg-card"
            onClick={() => void review('approved')}
          >
            通过
          </button>
          <input
            placeholder="驳回意见"
            className="w-36 border border-line bg-card px-2 py-0.5 text-[11.5px] text-ink outline-none focus:border-wine"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className="rounded-full border border-wine px-2.5 py-0.5 text-[11.5px] text-wine-ink hover:opacity-80"
            onClick={() => void review('rejected')}
          >
            驳回
          </button>
        </span>
      )}
      {err && <span className="text-wine-ink">{err}</span>}
      {comp.has_file && (
        <div className="w-full">
          <PrecheckNotes precheck={comp.file_precheck} />
          <FilePreview url={orderBookComponentFileUrl(order.id, comp.id)} kind={comp.file_kind} />
        </div>
      )}
    </div>
  )
}

function BookReviewBlock({ order, books, onUpdated }: { order: OrderDto; books: OrderBookDto[]; onUpdated: (o: OrderDto) => void }) {
  return (
    <div className="mt-4">
      <div className="mb-1 font-mono text-[10px] tracking-[.14em] text-dim">审稿 · 册子 {books.length}</div>
      {books.map((b) => (
        <div key={b.id} className="mb-2 border-b border-line pb-1 last:border-b-0">
          <div className="text-[13px] font-medium text-ink">
            📖 {b.name} <span className="text-[12px] text-dim">×{b.count}</span>
          </div>
          {b.components.map((c) => (
            <BookComponentReviewRow key={c.id} order={order} comp={c} onUpdated={onUpdated} />
          ))}
        </div>
      ))}
    </div>
  )
}

function OrderDetail({ order, onUpdated, onRefresh }: { order: OrderDto; onUpdated: (o: OrderDto) => void; onRefresh: () => void }) {
  const [payKind, setPayKind] = useState<'deposit' | 'balance' | 'refund'>('deposit')
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('')
  const [discount, setDiscount] = useState(String(order.discount))
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setPayKind('deposit')
    setPayAmount('')
    setPayMethod('')
    setDiscount(String(order.discount))
    setErr(null)
  }, [order.id, order.discount])

  const advance = async (to: string) => {
    setErr(null)
    const res = await patchOrderStatus(order.id, to)
    if (res.ok) {
      onUpdated(res.data)
      onRefresh()
    } else {
      const code = (res.data as { error?: string })?.error ?? String(res.status)
      setErr(code === 'quote_expired' ? '报价已过期，不可确认（需重新下单）。' : `操作失败（${code}）`)
    }
  }

  const savePayment = async () => {
    setErr(null)
    const mag = Number(payAmount)
    if (!Number.isSafeInteger(mag) || mag <= 0) {
      setErr('金额须为正整数（最小货币单位）。')
      return
    }
    // 退款落负数；收款落正数（amount 带符号）
    const signed = payKind === 'refund' ? -mag : mag
    const res = await recordPayment(order.id, {
      kind: payKind,
      amount: signed,
      method: payMethod.trim() === '' ? null : payMethod.trim(),
    })
    if (res.ok) {
      setPayAmount('')
      setPayMethod('')
      onUpdated(res.data)
      onRefresh()
    } else {
      const code = (res.data as { error?: string })?.error ?? String(res.status)
      setErr(
        code === 'paid_exceeds_total'
          ? '收款超过应付总额。'
          : code === 'refund_exceeds_paid'
            ? '退款超过已收金额。'
            : `记账失败（${code}）`,
      )
    }
  }

  const saveDiscount = async () => {
    setErr(null)
    const value = Number(discount)
    if (!Number.isSafeInteger(value) || value < 0) {
      setErr('折扣必须是非负整数减额（C7 禁百分比）。')
      return
    }
    const res = await patchOrderDiscount(order.id, value)
    if (res.ok) {
      onUpdated(res.data)
      onRefresh()
    } else {
      const code = (res.data as { error?: string })?.error ?? String(res.status)
      setErr(code === 'discount_exceeds_subtotal' ? '折扣不能超过小计。' : `折扣保存失败（${code}）`)
    }
  }

  const cancellable = !['delivered', 'cancelled'].includes(order.status)

  return (
    <div className="mt-6 border border-ink bg-card p-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-b border-ink pb-3">
        <span className="font-mono text-[15px] text-ink">{order.order_number}</span>
        <span className="font-mono text-[10.5px] tracking-[.14em] text-wine-ink">
          {ORDER_STATUS_LABEL[order.status].toUpperCase()}
        </span>
        <span className="text-[13px] text-dim">
          {order.customer?.name}（{order.customer?.email}）
        </span>
        {order.is_internal && (
          <span className="border border-ink px-1.5 py-0.5 font-mono text-[10px] tracking-[.1em] text-ink">内部</span>
        )}
        {order.quote_expired && (
          <span className="font-mono text-[10.5px] tracking-[.1em] text-warn">报价过期</span>
        )}
        {order.contact_info && <span className="text-[12px] text-dim">联系：{order.contact_info}</span>}
        {order.delivery_method === 'shipping' && (
          <span className="text-[12px] text-wine-ink">邮寄：{order.delivery_address}</span>
        )}
        <span className="ml-auto font-mono text-[10.5px] text-dim">
          <a href={`#/order/${order.access_token}`} className="underline hover:text-ink">客户视图 →</a>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-[7fr_5fr]">
        <div className="pt-3">
          <div className="mb-1 font-mono text-[10px] tracking-[.14em] text-dim">审稿 · ITEMS {order.items.length}</div>
          {order.items.map((item) => (
            <ReviewRow key={item.id} order={order} item={item} onUpdated={onUpdated} />
          ))}
          {order.books && order.books.length > 0 && (
            <BookReviewBlock order={order} books={order.books} onUpdated={onUpdated} />
          )}
          {order.notes && <p className="mt-3 text-[12.5px] text-dim">备注：{order.notes}</p>}
        </div>

        <div className="pt-3">
          <SpecRow label="小计" value={order.subtotal_display} />
          <SpecRow label="折扣" value={`−${order.discount_display}`} />
          <SpecRow label="应付" strong value={order.total_display} />
          <SpecRow
            label="已收"
            note={PAY_LABEL[order.payment_status]}
            value={order.paid_amount_display}
          />
          {order.status === 'cancelled' && (order.refund_due ?? 0) > 0 && (
            <p className="mt-2 border border-warn bg-warn/10 px-3 py-2 text-[12.5px] leading-[1.7] text-warn">
              订单已取消但已收 {order.refund_due_display}——系统不自动退款，请在下方收款流水「记一笔 · 退款」完成退款。
            </p>
          )}

          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              {(ACTIONS[order.status] ?? []).map((a) => (
                <button
                  key={a.to}
                  type="button"
                  onClick={() => void advance(a.to)}
                  className="rounded-full border border-wine bg-wine px-4 py-1.5 text-[13px] font-medium text-cream hover:opacity-90"
                >
                  {a.label} →
                </button>
              ))}
              {cancellable && (
                <button
                  type="button"
                  onClick={() => {
                    const paidWarn =
                      order.paid_amount > 0
                        ? `\n\n注意：已收 ${order.paid_amount_display}，取消不自动退款，需随后在收款流水记一笔退款。`
                        : ''
                    if (window.confirm(`取消订单 ${order.order_number}？未完成作业将一并取消。${paidWarn}`)) void advance('cancelled')
                  }}
                  className="rounded-full border border-line px-4 py-1.5 text-[13px] text-dim hover:border-wine hover:text-wine-ink"
                >
                  取消订单
                </button>
              )}
            </div>

            <div className="border-t border-line pt-3">
              <div className="mb-2 font-mono text-[10px] tracking-[.14em] text-dim">收款流水 · PAYMENTS</div>
              {order.payments && order.payments.length > 0 ? (
                <div className="mb-3">
                  {order.payments.map((p) => (
                    <div key={p.id} className="flex items-baseline gap-2 border-b border-line py-[5px] text-[12px]">
                      <span className="min-w-8 font-medium text-ink">{PAY_KIND_LABEL[p.kind]}</span>
                      {p.method && <span className="text-dim">{p.method}</span>}
                      <span className="font-mono text-[10.5px] text-dim">{p.created_at.slice(0, 10)}</span>
                      {p.note && <span className="text-dim">· {p.note}</span>}
                      <Leader />
                      <span className={`font-mono ${p.amount < 0 ? 'text-warn' : 'text-ink'}`}>{p.amount_display}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mb-2 text-[12px] text-dim">尚无收款记录。</p>
              )}
              <div className="grid grid-cols-[auto_1fr_1fr_auto] items-end gap-2">
                <select
                  className={`${specInput} w-auto`}
                  value={payKind}
                  onChange={(e) => setPayKind(e.target.value as typeof payKind)}
                >
                  <option value="deposit">押金</option>
                  <option value="balance">尾款</option>
                  <option value="refund">退款</option>
                </select>
                <Field label="金额（正整数）">
                  <input className={specInput} inputMode="numeric" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </Field>
                <Field label="方式 / 备注">
                  <input className={specInput} value={payMethod} onChange={(e) => setPayMethod(e.target.value)} />
                </Field>
                <button
                  type="button"
                  onClick={() => void savePayment()}
                  className="rounded-full border border-ink px-4 py-2 text-[13px] text-ink hover:bg-paper"
                >
                  记一笔
                </button>
              </div>
            </div>

            {['quoted', 'file_pending', 'file_approved'].includes(order.status) && (
              <div className="border-t border-line pt-3">
                <div className="mb-2 font-mono text-[10px] tracking-[.14em] text-dim">折扣（整数减额）</div>
                <div className="flex items-center gap-2">
                  <input
                    className={`${specInput} w-32`}
                    inputMode="numeric"
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => void saveDiscount()}
                    className="border border-ink px-4 py-2 text-[13px] text-ink hover:bg-card"
                  >
                    保存
                  </button>
                </div>
              </div>
            )}
            {err && <p className="text-[13px] text-wine-ink">{err}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

function KanbanBody() {
  const [orders, setOrders] = useState<OrderDto[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCancelled, setShowCancelled] = useState(false)

  const refresh = useCallback(() => {
    void fetchOrders().then((res) => {
      if (res.ok) setOrders(res.data)
    })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!orders) return <p className="pt-13 text-[14px] text-dim">订单加载中…</p>

  const selected = orders.find((o) => o.id === selectedId) ?? null
  const cancelled = orders.filter((o) => o.status === 'cancelled')

  const updateOne = (o: OrderDto) =>
    setOrders((prev) => (prev ? prev.map((x) => (x.id === o.id ? { ...x, ...o } : x)) : prev))

  return (
    <MagSec tag="看板" title="订单看板" note={`ACTIVE ${orders.length - cancelled.length} · CANCELLED ${cancelled.length}`}>
      <div className="grid grid-cols-2 gap-px border border-ink bg-ink md:grid-cols-3 lg:grid-cols-6">
        {COLUMNS.map((col) => {
          const colOrders = orders.filter((o) => col.statuses.includes(o.status))
          return (
            <div key={col.label} className="flex min-h-[180px] flex-col bg-paper">
              <div className="border-b border-ink px-3 py-2">
                <span className="text-[13px] font-medium text-ink">{col.label}</span>
                <span className="ml-2 font-mono text-[11px] text-dim">{colOrders.length}</span>
              </div>
              <div className="flex-1 space-y-px bg-paper">
                {colOrders.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setSelectedId(o.id === selectedId ? null : o.id)}
                    className={`block w-full px-3 py-2.5 text-left hover:bg-card ${selectedId === o.id ? 'bg-card' : ''}`}
                  >
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono text-[11.5px] text-ink">{o.order_number.slice(4)}</span>
                      <span className="font-mono text-[11.5px] text-wine-ink">{o.total_display}</span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-1 text-[11px] text-dim">
                      <span className="truncate">{o.customer?.name}</span>
                      <span className="whitespace-nowrap font-mono text-[10px]">
                        {o.status === 'file_pending'
                          ? '待审'
                          : o.status === 'file_approved'
                            ? '已审'
                            : PAY_LABEL[o.payment_status]}
                      </span>
                    </div>
                    {o.quote_expired && <div className="mt-0.5 font-mono text-[9.5px] text-warn">报价过期</div>}
                    {o.is_internal && <div className="mt-0.5 font-mono text-[9.5px] text-dim">内部</div>}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {selected && <OrderDetail order={selected} onUpdated={updateOne} onRefresh={refresh} />}

      {cancelled.length > 0 && (
        <div className="mt-5">
          <button
            type="button"
            className="font-mono text-[10.5px] tracking-[.14em] text-dim hover:text-ink"
            onClick={() => setShowCancelled((v) => !v)}
          >
            已取消 {cancelled.length} {showCancelled ? '▾' : '▸'}
          </button>
          {showCancelled &&
            cancelled.map((o) => (
              <div key={o.id} className="flex items-baseline gap-3 border-b border-line py-2 text-[12.5px] text-dim">
                <span className="font-mono">{o.order_number}</span>
                <span>{o.customer?.name}</span>
                <Leader />
                <span className="font-mono">{o.total_display}</span>
              </div>
            ))}
        </div>
      )}
    </MagSec>
  )
}

export default function AdminOrders() {
  return <AdminGate>{() => <KanbanBody />}</AdminGate>
}
