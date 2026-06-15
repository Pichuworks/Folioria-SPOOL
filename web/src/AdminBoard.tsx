import { useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import { send, setHighlightJobId } from './api'
import { MagSec, Skeleton } from './spec'

interface BoardJob {
  id: string
  title: string
  status: string
  quantity: number
  mode_name: string
  paper_name: string
  size_key: string
  due_date: string | null
}
interface BoardLane {
  printer_id: number
  code: string
  name: string
  status: string
  jobs: BoardJob[]
  offline_with_jobs: boolean
}

const PRINTER_STATUS_LABEL: Record<string, string> = {
  online: '在线',
  standby: '待机',
  maintenance: '维护',
  offline: '离线',
}
const JOB_STATUS_LABEL: Record<string, string> = { queued: '排队', printing: '打印中' }

function BoardBody() {
  const [lanes, setLanes] = useState<BoardLane[] | null>(null)
  useEffect(() => {
    void send<BoardLane[]>('GET', '/api/jobs/board').then((r) => r.ok && setLanes(r.data))
  }, [])
  if (!lanes) return <Skeleton />

  const totalActive = lanes.reduce((n, l) => n + l.jobs.length, 0)
  return (
    <MagSec tag="01" title="生产排程" note={`${totalActive} ACTIVE JOBS · queued / printing`}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {lanes.map((l) => {
          const offline = l.status === 'offline' || l.status === 'maintenance'
          return (
            <div key={l.printer_id} className={`border ${l.offline_with_jobs ? 'border-warn' : 'border-ink'} bg-card`}>
              <div className="flex items-baseline gap-2 border-b border-line px-3 py-2">
                <span className="font-mono text-[12px] font-medium text-ink">{l.code}</span>
                <span className="text-[11.5px] text-dim">{l.name}</span>
                <span
                  className={`ml-auto font-mono text-[10px] tracking-[.12em] ${offline ? 'text-warn' : 'text-dim'}`}
                >
                  {PRINTER_STATUS_LABEL[l.status] ?? l.status}
                </span>
              </div>
              {l.offline_with_jobs && (
                <div className="border-b border-warn/40 bg-warn/5 px-3 py-1.5 text-[11.5px] text-warn">
                  ⚠ {PRINTER_STATUS_LABEL[l.status]}机台仍压着 {l.jobs.length} 个作业，需改派或上线
                </div>
              )}
              <div className="px-3 py-2">
                {l.jobs.length === 0 ? (
                  <p className="py-3 text-center text-[12px] text-dim">空闲</p>
                ) : (
                  <>
                    {l.jobs.slice(0, 5).map((j) => (
                      <button
                        key={j.id}
                        type="button"
                        className="block w-full cursor-pointer border-b border-line py-[7px] text-left hover:bg-card last:border-b-0"
                        onClick={() => { setHighlightJobId(j.id); window.location.hash = '#/admin/jobs' }}
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="text-[13px] text-ink">{j.title}</span>
                          <span
                            className={`ml-auto font-mono text-[9.5px] tracking-[.1em] ${
                              j.status === 'printing' ? 'text-wine-ink' : 'text-dim'
                            }`}
                          >
                            {JOB_STATUS_LABEL[j.status] ?? j.status}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-dim">
                          <span>
                            {j.paper_name} · {j.size_key} · {j.quantity} 张
                          </span>
                          {j.due_date && (
                            <span className="ml-auto font-mono text-[10.5px]">交期 {j.due_date.slice(0, 10)}</span>
                          )}
                        </div>
                      </button>
                    ))}
                    {l.jobs.length > 5 && (
                      <a
                        href="#/admin/jobs"
                        className="block py-2 text-center font-mono text-[10.5px] tracking-[.12em] text-wine-ink hover:opacity-70"
                      >
                        +{l.jobs.length - 5} 个作业 →
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </MagSec>
  )
}

export default function AdminBoard() {
  return <AdminGate>{() => <BoardBody />}</AdminGate>
}
