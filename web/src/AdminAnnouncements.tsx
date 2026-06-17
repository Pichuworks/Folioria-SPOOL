import { useCallback, useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import {
  archiveAnnouncement,
  createAnnouncement,
  fetchAdminAnnouncements,
  updateAnnouncement,
  type AnnouncementDto,
} from './api'
import { Btn, Field, Leader, MagSec, Modal, specInput, TabBar } from './spec'

type Tab = 'all' | 'draft' | 'published' | 'expired' | 'archived'

const AUDIENCE_LABEL: Record<string, string> = { public: '公开', all: '全部用户', customers: '客户', staff: '内部' }

const audienceBadge = (a: string) => (
  <span className="border border-line px-1.5 py-px font-mono text-[9.5px] tracking-[.14em] text-dim">
    {AUDIENCE_LABEL[a] ?? a}
  </span>
)

function isExpired(a: AnnouncementDto) {
  return a.expires_at != null && new Date(a.expires_at) <= new Date()
}

function filterTab(list: AnnouncementDto[], tab: Tab): AnnouncementDto[] {
  switch (tab) {
    case 'draft': return list.filter((a) => !a.archived && a.published_at == null)
    case 'published': return list.filter((a) => !a.archived && a.published_at != null && !isExpired(a))
    case 'expired': return list.filter((a) => !a.archived && isExpired(a))
    case 'archived': return list.filter((a) => a.archived)
    default: return list.filter((a) => !a.archived)
  }
}

function AnnouncementsBody() {
  const [list, setList] = useState<AnnouncementDto[] | null>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [editing, setEditing] = useState<AnnouncementDto | null>(null)
  const [creating, setCreating] = useState(false)

  const [fetchError, setFetchError] = useState(false)
  const reload = useCallback(() => {
    void fetchAdminAnnouncements().then((r) => {
      if (r.ok) setList(r.data)
      else setFetchError(true)
    })
  }, [])

  useEffect(reload, [reload])

  const tabs = list
    ? [
        { key: 'all', label: '全部', count: filterTab(list, 'all').length },
        { key: 'draft', label: '草稿', count: filterTab(list, 'draft').length },
        { key: 'published', label: '已发布', count: filterTab(list, 'published').length },
        { key: 'expired', label: '已过期', count: filterTab(list, 'expired').length },
        { key: 'archived', label: '已归档', count: filterTab(list, 'archived').length },
      ]
    : [{ key: 'all', label: '全部' }]

  const visible = list ? filterTab(list, tab) : null

  return (
    <div>
      <MagSec title="公告管理" note={visible ? `${visible.length} 条` : undefined}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Btn onClick={() => { setEditing(null); setCreating(true) }}>新建公告</Btn>
        </div>

        <TabBar tabs={tabs} active={tab} onChange={(k) => setTab(k as Tab)} />

        {fetchError ? (
          <p className="py-2 text-[13px] text-wine-ink">公告列表加载失败，请刷新重试。</p>
        ) : !visible ? (
          <p className="py-2 text-[13px] text-dim">加载中…</p>
        ) : visible.length === 0 ? (
          <p className="py-2 text-[13px] text-dim">暂无公告</p>
        ) : (
          visible.map((a) => (
            <div key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-[9px]">
              {a.pinned && (
                <span className="border border-wine px-1.5 py-px font-mono text-[9.5px] tracking-[.14em] text-wine-ink">
                  PINNED#{a.pin_sort}
                </span>
              )}
              {audienceBadge(a.audience)}
              {a.published_at == null ? (
                <span className="font-mono text-[10px] tracking-[.1em] text-dim">DRAFT</span>
              ) : isExpired(a) ? (
                <span className="font-mono text-[10px] tracking-[.1em] text-warn">EXPIRED</span>
              ) : (
                <span className="font-mono text-[10px] tracking-[.1em] text-ink">
                  {a.published_at.slice(0, 10)}
                </span>
              )}
              {a.archived && (
                <span className="font-mono text-[10px] tracking-[.1em] text-dim">ARCHIVED</span>
              )}
              <span className="text-[13px] text-ink">{a.title}</span>
              <Leader />
              <span className="text-[11px] text-dim">{a.author_name ?? '—'}</span>
              <button
                type="button"
                className="font-mono text-[10.5px] tracking-[.1em] text-dim hover:text-ink"
                onClick={() => { setCreating(false); setEditing(a) }}
              >
                编辑
              </button>
              {!a.archived && (
                <button
                  type="button"
                  className="font-mono text-[10.5px] tracking-[.1em] text-wine-ink hover:opacity-70"
                  onClick={() => { void archiveAnnouncement(a.id).then(reload) }}
                >
                  归档
                </button>
              )}
            </div>
          ))
        )}
      </MagSec>

      {(creating || editing) && (
        <EditModal
          item={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); reload() }}
        />
      )}
    </div>
  )
}

function EditModal({ item, onClose, onSaved }: { item: AnnouncementDto | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item?.title ?? '')
  const [body, setBody] = useState(item?.body ?? '')
  const [audience, setAudience] = useState(item?.audience ?? 'all')
  const [pinned, setPinned] = useState(item?.pinned ?? false)
  const [pinSort, setPinSort] = useState(item?.pin_sort ?? 0)
  const [expiresAt, setExpiresAt] = useState(item?.expires_at?.slice(0, 16) ?? '')
  const [busy, setBusy] = useState(false)

  const save = async (publish: boolean) => {
    if (!title.trim()) return
    setBusy(true)
    const exp = expiresAt ? new Date(expiresAt).toISOString() : null
    if (item) {
      const patch: Record<string, unknown> = { title, body, audience, pinned, pin_sort: pinSort, expires_at: exp }
      if (publish && !item.published_at) patch.published_at = new Date().toISOString()
      else if (!publish && item.published_at) patch.published_at = null
      await updateAnnouncement(item.id, patch)
    } else {
      await createAnnouncement({ title, body, audience, pinned, pin_sort: pinSort, expires_at: exp, publish })
    }
    setBusy(false)
    onSaved()
  }

  return (
    <Modal open onClose={onClose} title={item ? '编辑公告' : '新建公告'} wide>
      <div className="flex flex-col gap-4">
        <Field label="标题">
          <input className={specInput} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="内容">
          <textarea className={`${specInput} min-h-32`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="受众">
            <select className={specInput} value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)}>
              <option value="public">公开（含访客）</option>
              <option value="all">全部用户</option>
              <option value="customers">客户</option>
              <option value="staff">内部</option>
            </select>
          </Field>
          <Field label="过期时间（可选）">
            <input type="datetime-local" className={specInput} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] text-dim">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            置顶滚动横幅
          </label>
          {pinned && (
            <label className="flex items-center gap-2 text-[13px] text-dim">
              排序
              <input
                type="number"
                min={0}
                className={`${specInput} w-20`}
                value={pinSort}
                onChange={(e) => setPinSort(Math.max(0, parseInt(e.target.value) || 0))}
              />
              <span className="text-[11px]">（越小越靠前）</span>
            </label>
          )}
        </div>
        <div className="flex gap-3 pt-2">
          <Btn variant="subtle" disabled={busy || !title.trim()} onClick={() => void save(false)}>
            {item?.published_at ? '撤回为草稿' : '保存草稿'}
          </Btn>
          <Btn disabled={busy || !title.trim()} onClick={() => void save(true)}>
            {item?.published_at ? '保存' : '发布'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function AdminAnnouncements() {
  return <AdminGate>{() => <AnnouncementsBody />}</AdminGate>
}
