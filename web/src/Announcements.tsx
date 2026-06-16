import { useEffect, useState } from 'react'
import { renderMarkdown } from './markdown'
import { fetchUserAnnouncements, markAnnouncementRead, type UserAnnouncementDto } from './api'
import CustomerGate from './CustomerGate'
import { MagSec, Modal, Paginator, usePagination } from './spec'

function AnnouncementsBody() {
  const [list, setList] = useState<UserAnnouncementDto[] | null>(null)
  const [detail, setDetail] = useState<UserAnnouncementDto | null>(null)

  useEffect(() => {
    void fetchUserAnnouncements().then((data) => {
      const unread = data.filter((a) => !a.read)
      for (const a of unread) void markAnnouncementRead(a.id)
      setList(data.map((a) => ({ ...a, read: true })))
    })
  }, [])

  const { page, totalPages, paged, setPage } = usePagination(list ?? [], 10)

  return (
    <>
      <MagSec title="公告" note={list ? `${list.length} 条` : undefined}>
        {!list ? (
          <p className="py-2 text-[13px] text-dim">加载中…</p>
        ) : list.length === 0 ? (
          <p className="py-2 text-[13px] text-dim">暂无公告</p>
        ) : (
          <>
            {paged.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setDetail(a)}
                className="flex w-full items-baseline gap-3 border-b border-line py-3 text-left hover:bg-deep/40"
              >
                {a.pinned && (
                  <span className="border border-wine px-1.5 py-px font-mono text-[9.5px] tracking-[.14em] text-wine-ink">
                    PINNED
                  </span>
                )}
                <span className="font-mono text-[10px] tracking-[.08em] text-dim">
                  {a.published_at.slice(0, 10)}
                </span>
                <span className="flex-1 truncate text-[14px] font-medium text-ink">{a.title}</span>
              </button>
            ))}
            <Paginator page={page} totalPages={totalPages} onPage={setPage} />
          </>
        )}
      </MagSec>

      {detail && (
        <Modal open onClose={() => setDetail(null)} title={detail.title} wide>
          <div className="mb-3 font-mono text-[10px] tracking-[.08em] text-dim">
            {detail.published_at.slice(0, 10)}
          </div>
          {detail.body ? (
            <div
              className="prose-ann text-[14px] leading-[1.85] text-dim"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.body) }}
            />
          ) : (
            <p className="text-[13px] text-dim">无正文内容</p>
          )}
        </Modal>
      )}
    </>
  )
}

export default function Announcements() {
  return <CustomerGate>{() => <AnnouncementsBody />}</CustomerGate>
}
