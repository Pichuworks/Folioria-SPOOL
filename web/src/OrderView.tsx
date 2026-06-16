import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  claimOrder,
  fetchMe,
  fetchOrderByToken,
  getMeCache,
  orderBookComponentFileUrl,
  ORDER_STATUS_LABEL,
  orderItemFileUrl,
  patchOrderStatus,
  send,
  setReorder,
  uploadOrderBookComponentFile,
  uploadOrderItemFile,
  type MeDto,
  type OrderDto,
  type OrderItemDto,
} from './api'
import { Btn, Leader, MagSec, SpecRow } from './spec'

const CAT_LABEL: Record<string, string> = {
  bw: '黑白',
  color: '彩色',
  'photo-value': '照片·性价比',
  'photo-premium': '照片·高质量',
  'photo-art': '照片·艺术微喷',
}
const TECH_LABEL: Record<string, string> = { laser: '激光', inkjet: '喷墨' }

function itemLabel(i: OrderItemDto) {
  const cat = CAT_LABEL[i.category] ?? i.category
  const tech = TECH_LABEL[i.tech] ?? i.tech
  const duplex = i.duplex ? '·双面' : ''
  return `${cat}${tech}${duplex} · ${i.paper_name} · ${i.size_label}`
}

export const FILE_STATUS_LABEL: Record<OrderItemDto['file_status'], string> = {
  pending: '待审稿',
  approved: '审稿通过',
  rejected: '已驳回',
}

/** D35 文件预检提示（advisory）：警告标橙、其余作灰；空则不渲染。OrderView 与 AdminOrders 共用 */
export function PrecheckNotes({ precheck }: { precheck?: OrderItemDto['file_precheck'] }) {
  if (!precheck || precheck.items.length === 0) return null
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5">
      {precheck.items.map((it, i) => (
        <span key={i} className={`text-[10.5px] leading-[1.5] ${it.level === 'warn' ? 'text-warn' : 'text-dim'}`}>
          {it.level === 'warn' ? '⚠ ' : '· '}
          {it.message}
        </span>
      ))}
    </div>
  )
}

const BOOK_ROLE_LABEL: Record<string, string> = { cover: '封面', inner: '内页', insert: '插图' }

const fmtTime = (t: string) => t.slice(0, 16).replace('T', ' ')

/** C2 订单状态时间线：用既有里程碑时间戳（下单/确认/收款/完成）+ 交期目标 */
function Timeline({ order }: { order: OrderDto }) {
  const paidLabel =
    order.payment_status === 'paid' ? '付清' : order.payment_status === 'deposit' ? '收定金' : '收款'
  const nodes: Array<{ label: string; time: string | null; done: boolean; target?: boolean }> = [
    { label: '下单', time: order.created_at, done: true },
    { label: '确认排产', time: order.confirmed_at, done: order.confirmed_at != null },
    { label: paidLabel, time: order.paid_at, done: order.paid_at != null },
    {
      label: order.status === 'cancelled' ? '已取消' : '完成交付',
      time: order.completed_at,
      done: order.completed_at != null,
    },
  ]
  if (order.due_date) nodes.splice(3, 0, { label: '交期', time: order.due_date, done: false, target: true })

  return (
    <div className="mt-5">
      <div className="mb-2 font-mono text-[10px] tracking-[.14em] text-dim">进度时间线 · TIMELINE</div>
      <ol className="space-y-2">
        {nodes.map((n, i) => (
          <li key={i} className="flex items-baseline gap-2.5 text-[12.5px]">
            <span
              className={`mt-[3px] inline-block h-[7px] w-[7px] shrink-0 rounded-full border ${
                n.done ? 'border-wine bg-wine' : n.target ? 'border-ink bg-paper' : 'border-line bg-paper'
              }`}
            />
            <span className={n.done ? 'text-ink' : n.target ? 'text-ink' : 'text-dim'}>{n.label}</span>
            <Leader />
            <span className="font-mono text-[10.5px] text-dim">
              {n.time ? fmtTime(n.time) : n.target ? '目标' : '—'}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** D31 书组件文件行：状态 + owner 上传/下载（与 ItemRow 同口径，每个组件单独审稿） */
function BookCompFile({
  order,
  comp,
  canUpload,
  isOwner,
  onChanged,
}: {
  order: OrderDto
  comp: NonNullable<OrderDto['books']>[number]['components'][number]
  canUpload: boolean
  isOwner: boolean
  onChanged: (o: OrderDto) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pick = async (file: File) => {
    setBusy(true)
    setErr(null)
    const res = await uploadOrderBookComponentFile(order.id, comp.id, file)
    setBusy(false)
    if (res.ok) onChanged(res.data as OrderDto)
    else {
      const code = (res.data as { error?: string })?.error ?? String(res.status)
      setErr(UPLOAD_ERROR_TEXT[code] ?? `上传失败（${code}）`)
    }
  }

  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-9 text-[11.5px]">
      {comp.has_file ? (
        <>
          <span
            className={`font-mono text-[10px] tracking-[.1em] ${
              comp.file_status === 'approved' ? 'text-ink' : comp.file_status === 'rejected' ? 'text-warn' : 'text-dim'
            }`}
          >
            {FILE_STATUS_LABEL[comp.file_status]}
          </span>
          {comp.file_note && <span className="text-warn">审稿意见：{comp.file_note}</span>}
          {isOwner && (
            <a className="text-dim underline hover:text-ink" href={orderBookComponentFileUrl(order.id, comp.id)}>
              下载
            </a>
          )}
        </>
      ) : (
        <span className="font-mono text-[10px] tracking-[.1em] text-dim">未上传文件</span>
      )}
      {canUpload && (
        <>
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.png,.tif,.tiff,application/pdf,image/png,image/tiff"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void pick(f)
              e.target.value = ''
            }}
          />
          <Btn variant="ghost" size="xs" disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? '上传中…' : comp.has_file ? '重新上传' : '上传文件'}
          </Btn>
        </>
      )}
      {err && <span className="text-[11.5px] text-wine-ink">{err}</span>}
      {comp.has_file && <PrecheckNotes precheck={comp.file_precheck} />}
    </div>
  )
}

/** D27 书行展示（下单域：仅售价侧；机器对客户不可见）。D31 每组件加文件上传/审稿状态 */
const BookLine = memo(function BookLine({
  book,
  order,
  canUpload,
  isOwner,
  onChanged,
}: {
  book: NonNullable<OrderDto['books']>[number]
  order: OrderDto
  canUpload: boolean
  isOwner: boolean
  onChanged: (o: OrderDto) => void
}) {
  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[14px] font-medium text-ink">📖 {book.name}</span>
        <span className="text-[12.5px] text-dim">
          {book.unit_display}/本 × {book.count}
        </span>
        <Leader />
        <span className="font-mono text-[13.5px] text-wine-ink">{book.line_total_display}</span>
      </div>
      <div className="mt-1 pl-4">
        {book.components.map((c) => (
          <div key={c.id}>
            <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-dim">
              <span className="min-w-9 text-ink">{BOOK_ROLE_LABEL[c.role] ?? c.role}</span>
              <span>
                {c.paper_name} · {c.size_label}
                {c.duplex ? ' · 双面' : ''}
              </span>
              <span className="font-mono">· {c.sheets_per_book} 张/本</span>
            </div>
            <BookCompFile order={order} comp={c} canUpload={canUpload} isOwner={isOwner} onChanged={onChanged} />
          </div>
        ))}
        {book.finishings.length > 0 && (
          <p className="mt-1 text-[11.5px] text-dim">工艺：{book.finishings.map((f) => f.name).join('、')}</p>
        )}
      </div>
    </div>
  )
})

export function StatusBadge({ status }: { status: OrderDto['status'] }) {
  const tone =
    status === 'cancelled'
      ? 'text-dim border-line'
      : status === 'delivered'
        ? 'text-ink border-ink'
        : 'text-wine-ink border-wine'
  return (
    <span className={`border px-2 py-0.5 font-mono text-[10.5px] tracking-[.14em] ${tone}`}>
      {ORDER_STATUS_LABEL[status]}
    </span>
  )
}

const UPLOAD_ERROR_TEXT: Record<string, string> = {
  unsupported_file_type: '仅收 PDF / TIFF / PNG。',
  file_content_mismatch: '文件内容与扩展名不符，请导出正确格式后重传。',
  file_too_large: '文件超过 200MB 上限。',
}

const ItemRow = memo(function ItemRow({
  order,
  item,
  canUpload,
  isOwner,
  onChanged,
}: {
  order: OrderDto
  item: OrderItemDto
  canUpload: boolean
  isOwner: boolean
  onChanged: (o: OrderDto) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pick = async (file: File) => {
    setBusy(true)
    setErr(null)
    const res = await uploadOrderItemFile(order.id, item.id, file)
    setBusy(false)
    if (res.ok) onChanged(res.data as OrderDto)
    else {
      const code = (res.data as { error?: string })?.error ?? String(res.status)
      setErr(UPLOAD_ERROR_TEXT[code] ?? `上传失败（${code}）`)
    }
  }

  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[14px] font-medium text-ink">
          {itemLabel(item)}
        </span>
        <span className="text-[12.5px] text-dim">
          {item.unit_display}/张 × {item.quantity}
        </span>
        <Leader />
        <span className="font-mono text-[13.5px] text-wine-ink">{item.line_total_display}</span>
      </div>
      {item.finishings && item.finishings.length > 0 && (
        <div className="mt-1 text-[12px] text-dim">
          工艺：{item.finishings.map((f) => `${f.name}(${f.contribution_display})`).join('、')}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {item.has_file ? (
          <>
            <span
              className={`font-mono text-[10.5px] tracking-[.1em] ${
                item.file_status === 'approved'
                  ? 'text-ink'
                  : item.file_status === 'rejected'
                    ? 'text-warn'
                    : 'text-dim'
              }`}
            >
              {FILE_STATUS_LABEL[item.file_status]}
            </span>
            {item.file_note && <span className="text-warn">审稿意见：{item.file_note}</span>}
            {isOwner && (
              <a className="text-dim underline hover:text-ink" href={orderItemFileUrl(order.id, item.id)}>
                下载已传文件
              </a>
            )}
          </>
        ) : (
          <span className="font-mono text-[10.5px] tracking-[.1em] text-dim">未上传文件</span>
        )}
        {canUpload && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.png,.tif,.tiff,application/pdf,image/png,image/tiff"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void pick(f)
                e.target.value = ''
              }}
            />
            <Btn variant="ghost" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? '上传中…' : item.has_file ? '重新上传' : '上传文件'}
            </Btn>
            <span className="text-[10.5px] text-dim">PDF / TIFF / PNG · ≤200MB</span>
          </>
        )}
        {err && <span className="text-[12px] text-wine-ink">{err}</span>}
      </div>
      {item.has_file && <PrecheckNotes precheck={item.file_precheck} />}
    </div>
  )
})

/** R8 #/order/:token：公开订单查询（防枚举随机 token）；登录的下单账号可上传/取消 */
export default function OrderView({ token }: { token: string }) {
  const [order, setOrder] = useState<OrderDto | null | undefined>(undefined)
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)
  const [isOwner, setIsOwner] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetchOrderByToken(token)
    setOrder(res.ok ? res.data : null)
    return res.ok ? res.data : null
  }, [token])

  useEffect(() => {
    void refresh()
    fetchMe().then(setMe).catch(() => setMe(null))
  }, [refresh])

  useEffect(() => {
    // 归属判定：owner/admin 的 /api/orders/:id 200，其余 404（不泄露存在性）
    if (!order || !me) {
      setIsOwner(false)
      return
    }
    void send<OrderDto>('GET', `/api/orders/${order.id}`).then((r) => setIsOwner(r.ok))
  }, [order?.id, me?.id])

  if (order === undefined) return <p className="pt-13 text-[14px] text-dim">订单加载中…</p>
  if (order === null) {
    return (
      <MagSec title="订单查询">
        <p className="text-[15px] text-wine-ink">没有找到对应的订单。</p>
        <p className="mt-2 text-[13px] leading-[1.85] text-dim">
          请核对查询链接是否完整；订单号（FOL-…）不能用于查询，需要使用下单时获得的专属链接。
        </p>
      </MagSec>
    )
  }

  const canUpload = isOwner && (order.status === 'quoted' || order.status === 'file_pending')
  const canCancel = isOwner && ['quoted', 'file_pending', 'file_approved'].includes(order.status)

  const cancel = async () => {
    if (!window.confirm('确认取消该订单？')) return
    const res = await patchOrderStatus(order.id, 'cancelled')
    if (res.ok) setOrder({ ...res.data, access_token: order.access_token })
    else setActionErr(`取消失败（${(res.data as { error?: string })?.error ?? res.status}）`)
  }

  const reorder = () => {
    setReorder({
      items: order.items.map((i) => ({
        mode_id: i.mode_id,
        paper_id: i.paper_id,
        size_key: i.size_key,
        quantity: i.quantity,
        label: itemLabel(i),
      })),
      books: (order.books ?? []).map((b) => ({
        count: b.count,
        size_key: b.components[0]?.size_key ?? 'A4',
        components: b.components.map((c) => ({
          role: c.role as 'cover' | 'inner' | 'insert',
          paper_id: c.paper_id,
          color_class: c.color_class,
          duplex: c.duplex ? 1 : 0,
          sheets_per_book: c.sheets_per_book,
        })),
        finishing_ids: b.finishings.map((f) => f.finishing_id),
        label: b.name,
      })),
    })
    window.location.hash = '#/quote'
  }

  const claim = async () => {
    const res = await claimOrder(token)
    if (res.ok) {
      await refresh()
      setActionErr(null)
    } else {
      const e = (res.data as { error?: string })?.error
      setActionErr(
        e === 'verify_email_to_claim'
          ? '请先完成邮箱验证再认领。'
          : e === 'email_mismatch'
            ? '本订单留的邮箱与当前账号不一致，无法认领。'
            : `认领失败（${e ?? res.status}）`,
      )
    }
  }

  return (
    <MagSec title={order.order_number}>
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={order.status} />
        {order.quote_expired && (
          <span className="border border-warn px-2 py-0.5 font-mono text-[10.5px] tracking-[.14em] text-warn">
            报价已过期 · 需重新下单
          </span>
        )}
        <span className="font-mono text-[11px] text-dim">
          {order.created_at.slice(0, 10)} 下单 · 报价有效至 {order.quote_valid_until.slice(0, 10)}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-x-12 md:grid-cols-[7fr_5fr]">
        <div>
          <div className="mb-1 font-mono text-[10px] tracking-[.14em] text-dim">ITEMS · {order.items.length}</div>
          {order.items.map((item) => (
            <ItemRow
              key={item.id}
              order={order}
              item={item}
              canUpload={canUpload}
              isOwner={isOwner}
              onChanged={(o) => setOrder({ ...o, access_token: order.access_token })}
            />
          ))}
          {canUpload && order.status === 'quoted' && (
            <p className="mt-3 text-[12px] leading-[1.8] text-dim">全部行上传文件后自动进入审稿。</p>
          )}
          {!isOwner && me === null && (
            <p className="mt-3 text-[12px] leading-[1.8] text-dim">
              <a className="text-wine-ink underline" href="#/my/orders">登录下单账号</a> 后可在此上传文件。
            </p>
          )}
          {order.books && order.books.length > 0 && (
            <div className="mt-6">
              <div className="mb-1 font-mono text-[10px] tracking-[.14em] text-dim">书册 · {order.books.length}</div>
              {order.books.map((b) => (
                <BookLine
                  key={b.id}
                  book={b}
                  order={order}
                  canUpload={canUpload}
                  isOwner={isOwner}
                  onChanged={(o) => setOrder({ ...o, access_token: order.access_token })}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-8 md:mt-0">
          <div className="mb-1 font-mono text-[10px] tracking-[.14em] text-dim">SUMMARY</div>
          <SpecRow label="小计" value={order.subtotal_display} />
          {order.discount > 0 && <SpecRow label="折扣" value={`−${order.discount_display}`} />}
          <SpecRow label="应付" strong value={order.total_display} />
          <SpecRow
            label="付款"
            {...(order.payment_method ? { note: order.payment_method } : {})}
            value={
              order.payment_status === 'paid'
                ? `已付清 ${order.paid_amount_display}`
                : order.payment_status === 'deposit'
                  ? `已付定金 ${order.paid_amount_display}`
                  : '未付款'
            }
          />
          {order.status === 'cancelled' && order.paid_amount > 0 && (
            <p className="mt-2 border border-warn bg-warn/10 px-3 py-2 text-[12.5px] leading-[1.7] text-warn">
              订单已取消，已付 {order.paid_amount_display} 待退款——工坊将另行办理退款，如有疑问请联系工坊。
            </p>
          )}
          {order.delivery_method && (
            <SpecRow
              label="配送"
              {...(order.delivery_address ? { note: order.delivery_address } : {})}
              value={order.delivery_method === 'shipping' ? '邮寄' : '到店自取'}
            />
          )}
          <Timeline order={order} />
          {order.is_guest && me && (
            <div className="mt-5">
              <Btn variant="ghost" onClick={() => void claim()}>认领此订单到我的账号</Btn>
              <p className="mt-1.5 text-[11px] leading-[1.7] text-dim">需当前账号邮箱与下单邮箱一致且已验证。</p>
            </div>
          )}
          {canCancel && (
            <div className="mt-5">
              <Btn variant="subtle" onClick={() => void cancel()}>取消订单</Btn>
            </div>
          )}
          {(order.items.length > 0 || (order.books?.length ?? 0) > 0) && (
            <div className="mt-5">
              <Btn variant="ghost" onClick={reorder}>一键再下单 ↻</Btn>
              <p className="mt-1.5 text-[11px] text-dim">按现价重报后填入下单清单，可再调整。</p>
            </div>
          )}
          {actionErr && <p className="mt-2 text-[12.5px] text-wine-ink">{actionErr}</p>}
          <p className="mt-5 text-[11px] leading-[1.9] text-dim">
            本页链接含专属查询码，请妥善保存、勿外传。订单确认后如需变更请直接联系工坊。
          </p>
        </div>
      </div>
    </MagSec>
  )
}
