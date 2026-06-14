import { useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Leader, MagSec } from './spec'

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
  const [rows, setRows] = useState<AuditEntry[] | null>(null)
  useEffect(() => {
    void send<AuditEntry[]>('GET', '/api/admin/audit').then((r) => r.ok && setRows(r.data))
  }, [])
  if (!rows) return <p className="pt-13 text-[14px] text-dim">审计加载中…</p>
  return (
    <MagSec tag="审计" title="操作审计" note={`${rows.length} ENTRIES · 定价/折扣/收款/角色/设置`}>
      {rows.length === 0 && <p className="text-[13px] text-dim">暂无审计记录。</p>}
      {rows.map((r) => (
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
    </MagSec>
  )
}

export default function AdminAudit() {
  return <AdminGate>{() => <AuditBody />}</AdminGate>
}
