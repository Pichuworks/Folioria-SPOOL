import { useEffect, useRef, useState } from 'react'
import StarMessage from './StarMessage'
import type { StarEntry } from './types'

interface Props {
  stars: StarEntry[]
  finalMsg: StarEntry | null
  tagline: string[]
  glitchEnabled: boolean
  onFinale: () => void
}

export default function Credits({ stars, finalMsg, tagline, glitchEnabled, onFinale }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const msgRefs = useRef<(HTMLDivElement | null)[]>([])
  const offsetRef = useRef(0)
  const finaleRef = useRef(false)
  const [showFinale, setShowFinale] = useState(false)

  useEffect(() => {
    const box = boxRef.current
    const track = trackRef.current
    if (!box || !track || stars.length === 0) return

    const boxH = box.clientHeight
    offsetRef.current = boxH

    let last = performance.now()
    let raf: number
    const SPEED = 32

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      offsetRef.current -= SPEED * dt
      track.style.transform = `translateY(${offsetRef.current}px)`

      for (let i = 0; i < msgRefs.current.length; i++) {
        const el = msgRefs.current[i]
        if (!el || el.dataset.entered) continue
        if (el.offsetTop + offsetRef.current < boxH - 40) {
          el.style.opacity = '1'
          el.dataset.entered = '1'
        }
      }

      if (!finaleRef.current && offsetRef.current < -(track.scrollHeight - boxH * 0.3)) {
        finaleRef.current = true
        setShowFinale(true)
        onFinale()
      }

      raf = requestAnimationFrame(tick)
    }

    const start = setTimeout(() => { raf = requestAnimationFrame(tick) }, 500)
    return () => { clearTimeout(start); cancelAnimationFrame(raf) }
  }, [stars, onFinale])

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      offsetRef.current -= ev.deltaY * 0.5
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div ref={boxRef} className="fixed inset-0 z-[2] overflow-hidden" style={{ bottom: 80 }}>
      <div ref={trackRef} className="relative">
        {stars.map((s, i) => (
          <StarMessage
            key={s.id}
            ref={(el) => { msgRefs.current[i] = el }}
            star={s}
            glitchEnabled={glitchEnabled}
          />
        ))}
        <div style={{ height: '60vh' }} />
      </div>

      {showFinale && finalMsg && (
        <div className="fixed inset-0 z-[4] flex flex-col items-center justify-center" style={{ bottom: 80 }}>
          <div className="egg-fadein text-center">
            <div className="mx-auto mb-3 h-[4px] w-[4px] rounded-full" style={{ backgroundColor: '#f5e6c8' }} />
            <div className="mb-2 font-mono text-[12px] tracking-[.18em]" style={{ color: '#8B6914' }}>
              {finalMsg.signal}
            </div>
            <div className="mb-4 text-[22px] tracking-[.1em]" style={{ color: '#e8dcc8', fontFamily: 'var(--font-serif)' }}>
              {finalMsg.fullName}
            </div>
            <div className="mx-auto mb-10 max-w-lg text-[15px] leading-relaxed" style={{ color: '#c8bfb0' }}>
              {'「'}{finalMsg.message}{'」'}
            </div>
            <div className="space-y-1">
              {tagline.map((line, i) => (
                <div
                  key={i}
                  className="font-mono text-[11px] tracking-[.25em]"
                  style={{ color: '#8B6914', animationDelay: `${1.5 + i * 0.5}s` }}
                >
                  {line}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
