import { useEffect, useState } from 'react'
import { fetchUserAnnouncements, markAnnouncementRead, type UserAnnouncementDto } from './api'
import CustomerGate from './CustomerGate'
import { MagSec } from './spec'

function AnnouncementsBody() {
  const [list, setList] = useState<UserAnnouncementDto[] | null>(null)

  useEffect(() => {
    void fetchUserAnnouncements().then((data) => {
      const unread = data.filter((a) => !a.read)
      for (const a of unread) void markAnnouncementRead(a.id)
      setList(data.map((a) => ({ ...a, read: true })))
    })
  }, [])

  return (
    <MagSec tag="01" title="公告" note={list ? `${list.length} 条` : undefined}>
      {!list ? (
        <p className="py-2 text-[13px] text-dim">加载中…</p>
      ) : list.length === 0 ? (
        <p className="py-2 text-[13px] text-dim">暂无公告</p>
      ) : (
        list.map((a) => (
          <div key={a.id} className="border-b border-line py-4">
            <div className="flex items-baseline gap-3">
              {a.pinned && (
                <span className="border border-wine px-1.5 py-px font-mono text-[9.5px] tracking-[.14em] text-wine-ink">
                  PINNED
                </span>
              )}
              <span className="font-mono text-[10px] tracking-[.08em] text-dim">
                {a.published_at.slice(0, 10)}
              </span>
              <span className="text-[14px] font-medium text-ink">{a.title}</span>
              {!a.read && (
                <span className="inline-block h-2 w-2 rounded-full bg-wine" />
              )}
            </div>
            {a.body && (
              <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-[1.85] text-dim">{a.body}</p>
            )}
          </div>
        ))
      )}
    </MagSec>
  )
}

export default function Announcements() {
  return <CustomerGate>{() => <AnnouncementsBody />}</CustomerGate>
}
