import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fetchPublicAnnouncements, type PublicAnnouncementDto } from './api'

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
  const trackRef = useRef<HTMLDivElement>(null)
  const [dur, setDur] = useState(30)

  useEffect(() => {
    void fetchPublicAnnouncements().then((all) => {
      setItems(all.filter((a) => a.pinned).sort((a, b) => a.pin_sort - b.pin_sort))
    })
  }, [])

  useLayoutEffect(() => {
    if (!trackRef.current) return
    const w = trackRef.current.scrollWidth / 2
    setDur(Math.max(10, w / 60))
  }, [items])

  if (!items.length) return null

  const text = bannerText(items)
  const h = 'h-[22px]'
  const span = `inline-flex ${h} min-w-full items-center whitespace-nowrap px-8 font-mono text-[11px] tracking-[.06em] text-dim`

  return (
    <a href="#/announcements" className={`group/banner block ${h} -mb-[22px] overflow-hidden`}>
      <div
        ref={trackRef}
        className="flex animate-marquee whitespace-nowrap group-hover/banner:[animation-play-state:paused]"
        style={{ '--marquee-duration': `${dur}s` } as React.CSSProperties}
      >
        <span className={span}>{text}</span>
        <span className={span}>{text}</span>
      </div>
    </a>
  )
}
