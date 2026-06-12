import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchMe,
  fetchOrderByToken,
  getMeCache,
  ORDER_STATUS_LABEL,
  orderItemFileUrl,
  patchOrderStatus,
  send,
  uploadOrderItemFile,
  type MeDto,
  type OrderDto,
  type OrderItemDto,
} from './api'
import { Leader, MagSec, SpecRow } from './spec'

export const FILE_STATUS_LABEL: Record<OrderItemDto['file_status'], string> = {
  pending: '待审稿',
  approved: '审稿通过',
  rejected: '已驳回',
}

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

function ItemRow({
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
          {item.mode_name} × {item.paper_name} · {item.size_label}
        </span>
        <span className="text-[12.5px] text-dim">
          {item.unit_display}/张 × {item.quantity}
        </span>
        <Leader />
        <span className="font-mono text-[13.5px] text-wine-ink">{item.line_total_display}</span>
      </div>
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
              accept=".pdf,.png,.tif,.tiff"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void pick(f)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="rounded-full border border-wine px-3 py-1 text-[12px] text-wine-ink hover:opacity-80 disabled:opacity-50"
            >
              {busy ? '上传中…' : item.has_file ? '重新上传' : '上传文件'}
            </button>
            <span className="text-[10.5px] text-dim">PDF / TIFF / PNG · ≤200MB</span>
          </>
        )}
      </div>
    </div>
  )
}

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
      <MagSec tag="订单" title="订单查询" note="ORDER LOOKUP">
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

  return (
    <MagSec tag="订单" title={order.order_number} note="ORDER DETAIL">
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
          {canCancel && (
            <div className="mt-5">
              <button
                type="button"
                onClick={() => void cancel()}
                className="rounded-full border border-line px-4 py-2 text-[13px] text-dim hover:border-wine hover:text-wine-ink"
              >
                取消订单
              </button>
              {actionErr && <p className="mt-2 text-[12.5px] text-wine-ink">{actionErr}</p>}
            </div>
          )}
          <p className="mt-5 text-[11px] leading-[1.9] text-dim">
            本页链接含专属查询码，请妥善保存、勿外传。订单确认后如需变更请直接联系工坊。
          </p>
        </div>
      </div>
    </MagSec>
  )
}
