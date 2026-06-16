import { useEffect, useRef } from 'react'

export default function Sky() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cvs = ref.current
    if (!cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = window.innerWidth
    const h = window.innerHeight
    cvs.width = w * dpr
    cvs.height = h * dpr
    cvs.style.width = w + 'px'
    cvs.style.height = h + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const stars = Array.from({ length: 220 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.4 + Math.random() * 1.4,
      phase: Math.random() * Math.PI * 2,
      period: 2 + Math.random() * 4,
    }))

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf: number

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = '#f5e6c8'
      for (const s of stars) {
        ctx.globalAlpha = reduced ? 0.45 : 0.25 + 0.35 * Math.sin(t / 1000 / s.period * Math.PI * 2 + s.phase)
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fill()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={ref} className="fixed inset-0 z-[1]" style={{ pointerEvents: 'none' }} />
}
