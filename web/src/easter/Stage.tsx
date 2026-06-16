import { useEffect, useRef, useState } from 'react'
import Sprite from './Sprite'
import { InteractionEngine, loadRules } from './interactions'
import type { SpriteConfig, SpriteInstance } from './types'

function init(cfg: SpriteConfig, w: number): SpriteInstance {
  return {
    cfg,
    x: Math.random() * Math.max(w - 16, 1),
    state: 'walk',
    facingRight: Math.random() > 0.5,
    stateTimer: 0,
    walkDuration: 2 + Math.random() * 4,
    pauseDuration: cfg.pauseDuration[0] + Math.random() * (cfg.pauseDuration[1] - cfg.pauseDuration[0]),
    bouncePhase: Math.random() * Math.PI * 2,
    bubble: null,
    bubbleTimer: 0,
    soloYOffset: 0,
    soloType: null,
    soloDuration: 0,
    soloBubbles: [],
    soloBubbleIdx: 0,
  }
}

interface Props {
  sprites: SpriteConfig[]
  decryptionKey: string
}

export default function Stage({ sprites: cfgs, decryptionKey }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const all = useRef<SpriteInstance[]>([])
  const engineRef = useRef<InteractionEngine | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el || cfgs.length === 0) return
    const w = el.clientWidth
    all.current = cfgs.map(c => init(c, w))

    const rules = loadRules(decryptionKey)
    const engine = new InteractionEngine(rules, all.current)
    engineRef.current = engine

    setTick(1)

    let last = performance.now()
    let raf: number
    let frame = 0
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now

      for (const s of all.current) {
        s.stateTimer += dt

        if (s.state === 'walk') {
          const dir = s.facingRight ? 1 : -1
          s.x += s.cfg.speed * dir * 30 * dt
          if (!reduced) s.bouncePhase += dt * 4
          if (s.x < 0) { s.x = 0; s.facingRight = true }
          if (s.x > w - 16) { s.x = w - 16; s.facingRight = false }
          if (s.stateTimer > s.walkDuration) {
            s.state = 'idle'
            s.stateTimer = 0
            s.pauseDuration = s.cfg.pauseDuration[0] + Math.random() * (s.cfg.pauseDuration[1] - s.cfg.pauseDuration[0])
            s.bouncePhase = 0
          }
        } else if (s.state === 'idle') {
          if (s.stateTimer > s.pauseDuration) {
            s.state = 'walk'
            s.stateTimer = 0
            s.facingRight = Math.random() > 0.5
            s.walkDuration = 2 + Math.random() * 4
          }
        } else if (s.state === 'interact') {
          if (s.stateTimer > 3) {
            s.state = 'idle'
            s.stateTimer = 0
            s.pauseDuration = 0.5 + Math.random()
          }
        } else if (s.state === 'solo') {
          const ty = s.soloType
          if (ty === 'sprint') {
            const dir = s.facingRight ? 1 : -1
            s.x += s.cfg.speed * 3 * dir * 30 * dt
            if (!reduced) s.bouncePhase += dt * 8
            if (s.x < 0) { s.x = 0; s.facingRight = true }
            if (s.x > w - 16) { s.x = w - 16; s.facingRight = false }
          } else if (ty === 'big_bounce') {
            const dir = s.facingRight ? 1 : -1
            s.x += s.cfg.speed * dir * 30 * dt
            if (!reduced) {
              s.bouncePhase += dt * 4
              s.soloYOffset = Math.sin(s.bouncePhase) * s.cfg.bounceHeight * 1.5
            }
            if (s.x < 0) { s.x = 0; s.facingRight = true }
            if (s.x > w - 16) { s.x = w - 16; s.facingRight = false }
          } else if (ty === 'sequence' && s.soloBubbles.length > 0) {
            const idx = Math.min(Math.floor(s.stateTimer / 1.2), s.soloBubbles.length - 1)
            if (idx !== s.soloBubbleIdx && idx < s.soloBubbles.length) {
              s.soloBubbleIdx = idx
              s.bubble = s.soloBubbles[idx]!
              s.bubbleTimer = 1.0
            }
          } else if (ty === 'spin') {
            s.facingRight = Math.floor(s.stateTimer / 0.25) % 2 === 0
          } else if (ty === 'cat_antics') {
            if (s.stateTimer < 0.05) s.facingRight = !s.facingRight
            const dir = s.facingRight ? 1 : -1
            s.x += s.cfg.speed * 2 * dir * 30 * dt
            if (!reduced) s.bouncePhase += dt * 8
            if (s.x < 0) { s.x = 0; s.facingRight = true }
            if (s.x > w - 16) { s.x = w - 16; s.facingRight = false }
          }
          if (s.stateTimer > s.soloDuration) {
            if (s.soloType === 'turn') s.facingRight = !s.facingRight
            s.state = 'idle'
            s.stateTimer = 0
            s.soloType = null
            s.soloYOffset = 0
            s.soloBubbles = []
            s.soloBubbleIdx = 0
            s.pauseDuration = 0.5 + Math.random()
          }
        }

        if (s.bubble) {
          s.bubbleTimer -= dt
          if (s.bubbleTimer <= 0) s.bubble = null
        }
        if (!s.bubble && s.state !== 'interact' && s.cfg.dialogues.length > 0 && Math.random() < 0.0008) {
          s.bubble = s.cfg.dialogues[Math.floor(Math.random() * s.cfg.dialogues.length)] ?? null
          s.bubbleTimer = 2.2 + Math.random()
        }
      }

      engine.tick(all.current, dt)

      frame++
      if (frame % 2 === 0) setTick(n => n + 1)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [cfgs, decryptionKey])

  void tick
  return (
    <div ref={ref} className="fixed inset-x-0 bottom-0 z-[3]" style={{ height: 80, backgroundColor: '#0e1420' }}>
      <div className="absolute inset-x-0 top-0 h-px" style={{ backgroundColor: '#1a2233' }} />
      {all.current.map(s => <Sprite key={s.cfg.id} s={s} />)}
    </div>
  )
}
