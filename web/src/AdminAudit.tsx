import AdminGate from './AdminGate'
import { send } from './api'
import { Leader, MagSec, Paginator, Skeleton, usePagination } from './spec'
import { useFetch } from './useFetch'

interface AuditEntry {
  id: string
  actor_name: string | null
  action: string
  target_type: string
  target_id: string | null
  summary: string
  created_at: string
}

const ACTION_LABEL: Record<string, string> = {
  'payment.record': '收款',
  'order.discount': '折扣',
  'user.update': '用户',
  'settings.update': '设置',
  'pricing.combo_price': '定价',
}

function AuditBody() {
  const { data: rows, loading, error: fetchError } = useFetch(() =>
    send<AuditEntry[]>('GET', '/api/admin/audit').then((r) => { if (!r.ok) throw r; return r.data }),
  )
  const { page, totalPages, paged, setPage } = usePagination(rows ?? [], 50)
  if (fetchError) return <p className="p-8 text-[13px] text-wine-ink">审计记录加载失败，请刷新重试。</p>
  if (loading || !rows) return <Skeleton />

  return (
    <MagSec title="操作审计" note={`${rows.length} 条`}>
      {rows.length === 0 && <p className="text-[13px] text-dim">暂无审计记录。</p>}
      {paged.map((r) => (
        <div key={r.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-[7px]">
          <span className="min-w-10 font-mono text-[10px] tracking-[.1em] text-wine-ink">
            {ACTION_LABEL[r.action] ?? r.action}
          </span>
          <span className="text-[13px] text-ink">{r.summary}</span>
          <span className="text-[11.5px] text-dim">
            {r.target_type}
            {r.target_id ? ` ${r.target_id.slice(0, 8)}` : ''}
          </span>
          <Leader />
          <span className="text-[11.5px] text-dim">{r.actor_name ?? '—'}</span>
          <span className="font-mono text-[10.5px] text-dim">{r.created_at.slice(0, 16).replace('T', ' ')}</span>
        </div>
      ))}
      <Paginator page={page} totalPages={totalPages} onPage={setPage} />
      <div className="mt-3 text-right">
        <a href="/api/admin/audit/export" className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink">导出 XLSX ↧</a>
      </div>
    </MagSec>
  )
}

export default function AdminAudit() {
  return <AdminGate>{() => <AuditBody />}</AdminGate>
}
