import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { renderMarkdown } from './markdown'
import { fetchPublicAnnouncements, type PublicAnnouncementDto } from './api'
import { Modal } from './spec'

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, '$2')
    .replace(/`[^`]+`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^---+$/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function bannerText(items: PublicAnnouncementDto[]): string {
  return items
    .map((a) => {
      const body = a.body ? stripMarkdown(a.body) : ''
      return body ? `${a.title} — ${body}` : a.title
    })
    .join(' ◆ ')
}

export default function PinnedBanner() {
  const [items, setItems] = useState<PublicAnnouncementDto[]>([])
  const [detail, setDetail] = useState<PublicAnnouncementDto | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchPublicAnnouncements().then((all) => {
      setItems(all.filter((a) => a.pinned).sort((a, b) => a.pin_sort - b.pin_sort))
    })
  }, [])

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = () => {
      const first = track.children[0] as HTMLElement
      if (!first) return
      const w = first.getBoundingClientRect().width
      track.style.setProperty('--marquee-shift', `-${w}px`)
      track.style.setProperty('--marquee-duration', `${Math.max(10, w / 60)}s`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    return () => ro.disconnect()
  }, [items])

  if (!items.length) return null

  const text = bannerText(items)
  const span = 'inline-flex min-w-full items-center whitespace-nowrap px-8 py-[3px] font-mono text-[11px] tracking-[.06em] text-dim'

  const handleClick = () => {
    const first = items[0]
    if (first) setDetail(first)
  }

  return (
    <>
      <button type="button" onClick={handleClick} className="block w-full overflow-hidden text-left">
        <div
          ref={trackRef}
          className="flex animate-marquee whitespace-nowrap"
        >
          <span className={span}>{text}</span>
          <span className={span}>{text}</span>
        </div>
      </button>

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
          {items.length > 1 && (
            <div className="mt-6 border-t border-line pt-4">
              <div className="mb-2 font-mono text-[10px] tracking-[.14em] text-dim">其他置顶公告</div>
              {items.filter((a) => a.id !== detail.id).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setDetail(a)}
                  className="flex w-full items-baseline gap-3 border-b border-line py-2.5 text-left hover:bg-deep/40"
                >
                  <span className="font-mono text-[10px] tracking-[.08em] text-dim">{a.published_at.slice(0, 10)}</span>
                  <span className="flex-1 truncate text-[13px] font-medium text-ink">{a.title}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
