import { useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import {
  acknowledgeAlert,
  fetchAlerts,
  fetchNotifications,
  resolveAlertReq,
  scanAlerts,
  type AlertDto,
  type NotificationLogDto,
  type ScanResult,
} from './api'
import { Btn, Leader, MagSec, TabBar } from './spec'
import { useFetch } from './useFetch'

const sevClass = (s: string) =>
  s === 'critical' ? 'text-wine-ink' : s === 'warning' ? 'text-warn' : 'text-dim'

const statusClass = (s: string) =>
  s === 'sent' ? 'text-ink' : s === 'failed' ? 'text-wine-ink' : 'text-warn'

const TABS = [
  { key: 'alerts', label: '报警收件箱' },
  { key: 'notifications', label: '投递日志' },
] as const

type TabKey = (typeof TABS)[number]['key']

function AlertsBody() {
  const [tab, setTab] = useState<TabKey>('alerts')
  const [showAll, setShowAll] = useState(false)
  const { data: alerts, reload: reloadAlerts } = useFetch(() => fetchAlerts(showAll))
  const { data: notes, reload: reloadNotes } = useFetch(() => fetchNotifications())
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { reloadAlerts() }, [showAll]) // eslint-disable-line react-hooks/exhaustive-deps

  const runScan = async () => {
    setBusy(true)
    setScan(await scanAlerts())
    setBusy(false)
    reloadAlerts()
  }

  const tabsWithCounts = TABS.map((t) => {
    const c = t.key === 'alerts' ? alerts?.length : notes?.length
    return c != null ? { ...t, count: c } : { ...t }
  })

  return (
    <MagSec title="报警与通知">
      <TabBar tabs={tabsWithCounts} active={tab} onChange={(k) => setTab(k as TabKey)} />

      {tab === 'alerts' && (
        <div className="pt-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Btn onClick={() => void runScan()} disabled={busy}>
              {busy ? '扫描中…' : '立即扫描'}
            </Btn>
            <label className="flex items-center gap-2 text-[12.5px] text-dim">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              含已解决（历史）
            </label>
            {scan && (
              <span className="font-mono text-[11px] tracking-[.1em] text-dim">
                SCAN · 低库存 {scan.low_stock} · 耗材 {scan.consumable_low} · 校准 {scan.calibration_due}
              </span>
            )}
          </div>

          {!alerts ? (
            <p className="py-2 text-[13px] text-dim">加载中…</p>
          ) : alerts.length === 0 ? (
            <p className="py-2 text-[13px] text-dim">{showAll ? '无任何报警' : '无未解决报警'}</p>
          ) : (
            alerts.map((a) => (
              <div key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-[9px]">
                <span className={`min-w-16 font-mono text-[10px] tracking-[.1em] ${sevClass(a.severity)}`}>
                  {a.severity.toUpperCase()}
                </span>
                <span className="font-mono text-[10px] tracking-[.08em] text-dim">{a.type}</span>
                <span className="text-[13px] text-ink">{a.message}</span>
                <Leader />
                {a.resolved_at ? (
                  <span className="font-mono text-[10px] tracking-[.1em] text-dim">RESOLVED</span>
                ) : (
                  <>
                    {a.acknowledged ? (
                      <span className="font-mono text-[10px] tracking-[.1em] text-dim">ACK</span>
                    ) : (
                      <button
                        type="button"
                        className="font-mono text-[10.5px] tracking-[.1em] text-dim hover:text-ink"
                        onClick={() => void acknowledgeAlert(a.id).then(() => reloadAlerts())}
                      >
                        确认
                      </button>
                    )}
                    <button
                      type="button"
                      className="font-mono text-[10.5px] tracking-[.1em] text-wine-ink hover:opacity-70"
                      onClick={() => void resolveAlertReq(a.id).then(() => reloadAlerts())}
                    >
                      解决
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'notifications' && (
        <div className="pt-5">
          {!notes ? (
            <p className="py-2 text-[13px] text-dim">加载中…</p>
          ) : notes.length === 0 ? (
            <p className="py-2 text-[13px] text-dim">暂无通知记录</p>
          ) : (
            notes.map((n) => (
              <div key={n.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-[8px]">
                <span className={`min-w-16 font-mono text-[10px] tracking-[.1em] ${statusClass(n.status)}`}>
                  {n.status.toUpperCase()}
                </span>
                <span className="font-mono text-[10.5px] tracking-[.06em] text-dim">{n.event}</span>
                <span className="text-[12.5px] text-ink">{n.recipient}</span>
                {n.error && <span className="text-[11px] text-wine-ink">{n.error}</span>}
                <Leader />
                <span className="font-mono text-[10px] tracking-[.08em] text-dim">{n.sent_at.slice(0, 16).replace('T', ' ')}</span>
              </div>
            ))
          )}
        </div>
      )}
    </MagSec>
  )
}

export default function AdminAlerts() {
  return <AdminGate>{() => <AlertsBody />}</AdminGate>
}
