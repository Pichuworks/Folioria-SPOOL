import { useEffect, useRef, useState } from 'react'
import StarMessage from './StarMessage'
import type { StarEntry } from './types'

interface Props {
  stars: StarEntry[]
  finalMsg: StarEntry | null
  tagline: string[]
  ending: string[]
  glitchEnabled: boolean
  onFinale: () => void
}

type FinalePhase = 'nozomu' | 'ending' | null

export default function Credits({ stars, finalMsg, tagline, ending, glitchEnabled, onFinale }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const msgRefs = useRef<(HTMLDivElement | null)[]>([])
  const offsetRef = useRef(0)
  const finaleRef = useRef(false)
  const phaseRef = useRef<FinalePhase>(null)
  const [finalePhase, setFinalePhase] = useState<FinalePhase>(null)
  const [cycle, setCycle] = useState(0)

  useEffect(() => { phaseRef.current = finalePhase }, [finalePhase])

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

      if (phaseRef.current === null) {
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

        if (!finaleRef.current && offsetRef.current < -(track.scrollHeight - boxH * 0.5)) {
          finaleRef.current = true
          setFinalePhase('nozomu')
          onFinale()
        }
      }

      raf = requestAnimationFrame(tick)
    }

    const start = setTimeout(() => { raf = requestAnimationFrame(tick) }, 500)
    return () => { clearTimeout(start); cancelAnimationFrame(raf) }
  }, [stars, onFinale])

  useEffect(() => {
    if (finalePhase === 'nozomu') {
      const t = setTimeout(() => setFinalePhase('ending'), 10000)
      return () => clearTimeout(t)
    }
    if (finalePhase === 'ending') {
      const t = setTimeout(() => {
        const box = boxRef.current
        const track = trackRef.current
        if (box && track) {
          offsetRef.current = box.clientHeight
          track.style.transform = `translateY(${offsetRef.current}px)`
        }
        finaleRef.current = false
        for (const el of msgRefs.current) {
          if (el) {
            el.style.opacity = '0'
            delete el.dataset.entered
          }
        }
        setCycle(c => c + 1)
        setFinalePhase(null)
      }, 60000)
      return () => clearTimeout(t)
    }
  }, [finalePhase])

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      if (phaseRef.current === null) {
        offsetRef.current -= ev.deltaY * 0.5
      }
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div ref={boxRef} className="fixed inset-0 z-[2] overflow-hidden" style={{ bottom: 80 }}>
      <div ref={trackRef} className="relative">
        {stars.map((s, i) => (
          <StarMessage
            key={`${s.id}-${cycle}`}
            ref={(el) => { msgRefs.current[i] = el }}
            star={s}
            glitchEnabled={glitchEnabled}
          />
        ))}
        <div style={{ height: '30vh' }} />
      </div>

      {finalePhase === 'nozomu' && finalMsg && (
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

      {finalePhase === 'ending' && (
        <div className="fixed inset-0 z-[4] flex flex-col items-center justify-center" style={{ bottom: 80 }}>
          <div className="egg-fadein text-center">
            {ending.length >= 6 && (
              <>
                <div className="mb-1 text-[20px] tracking-[.12em]" style={{ color: '#e8dcc8', fontFamily: 'var(--font-serif)' }}>
                  {ending[0]}
                </div>
                <div className="mb-8 font-mono text-[13px] tracking-[.2em]" style={{ color: '#8B6914' }}>
                  {ending[1]}
                </div>
                <div className="mb-4 text-[12px]" style={{ color: '#c8bfb080' }}>
                  {ending[2]}
                </div>
                <div className="mb-2 text-[14px] leading-relaxed" style={{ color: '#c8bfb0' }}>
                  {ending[3]}
                </div>
                <div className="mb-6 text-[14px] leading-relaxed" style={{ color: '#c8bfb0' }}>
                  {ending[4]}
                </div>
                <div className="mb-10 text-[12px] leading-relaxed" style={{ color: '#c8bfb0a0' }}>
                  {ending[5]}
                </div>
              </>
            )}
            <div className="space-y-1">
              {tagline.map((line, i) => (
                <div
                  key={i}
                  className="font-mono text-[11px] tracking-[.25em]"
                  style={{ color: '#8B6914' }}
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
