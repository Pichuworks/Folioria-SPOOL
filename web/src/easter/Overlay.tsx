import { useState, useEffect, useRef, useCallback } from 'react'
import { decode, checkTrigger } from './codec'
import { _d } from './payload'
import type { StarEntry, SpriteConfig, Phase } from './types'
import Sky from './Sky'
import Credits from './Credits'
import Stage from './Stage'

const CSS = `
@keyframes egg-shimmer-kf{
  0%{color:#e8dcc8;text-shadow:none}
  40%{color:#c9a55a;text-shadow:0 0 8px #c9a55a80}
  70%{color:#c9a55a;text-shadow:0 0 6px #c9a55a40}
  100%{color:#e8dcc8;text-shadow:none}
}
.egg-shimmer{animation:egg-shimmer-kf 1s ease-in-out}
@keyframes egg-fadein-kf{
  from{opacity:0;transform:translateY(20px)}
  to{opacity:1;transform:translateY(0)}
}
.egg-fadein{animation:egg-fadein-kf 2s ease-out forwards}
@keyframes egg-bubble-kf{
  0%{opacity:0}10%{opacity:1}75%{opacity:1}100%{opacity:0;transform:translate(-50%,-8px)}
}
.egg-bubble{animation:egg-bubble-kf 4s ease-out forwards;text-shadow:0 0 4px #0a0f1a,0 0 8px #0a0f1a,0 1px 2px #0a0f1a}
.egg-msg{transition:opacity 1.2s ease-out}
.egg-root{font-variant-emoji:text}
`

interface Props {
  decryptionKey: string
  onClose: () => void
}

export default function Overlay({ decryptionKey, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('entering')
  const [stars, setStars] = useState<StarEntry[]>([])
  const [sprites, setSprites] = useState<SpriteConfig[]>([])
  const [finalMsg, setFinalMsg] = useState<StarEntry | null>(null)
  const [tagline, setTagline] = useState<string[]>([])
  const [ending, setEnding] = useState<string[]>([])
  const [catCredits, setCatCredits] = useState<{ name: string; color: string }[]>([])
  const [glitch, setGlitch] = useState(false)
  const [vis, setVis] = useState(false)
  const keyRef = useRef(decryptionKey)

  const handleFinale = useCallback(() => setPhase('finale'), [])

  useEffect(() => {
    const d = (s: string) => decode(s, keyRef.current)

    setStars(_d.s.filter(ch => !(ch as any).cat).map(ch => ({
      id: ch.i,
      fullName: d(ch.n),
      familyName: d(ch.f),
      givenName: d(ch.g),
      intimate: ch.x === 1,
      signal: d(ch.q),
      message: d(ch.m),
      color: ch.c,
    })))

    const bMap = _d.b as Record<string, { sp: number; pc: number; pd: number[]; bh: number; dl: string[]; cat?: number }>
    const mutsumiCh = _d.s.find(ch => ch.i === 'mutsumi')
    const charSprites: SpriteConfig[] = _d.s
      .filter(ch => ch.i !== 'mutsumi')
      .map(ch => {
        const b = bMap[ch.i]!
        const cfg: SpriteConfig = {
          id: ch.i,
          displayName: d(ch.d),
          color: ch.c,
          speed: b.sp,
          pauseChance: b.pc,
          pauseDuration: [b.pd[0], b.pd[1]] as [number, number],
          bounceHeight: b.bh,
          isCat: !!b.cat,
          dialogues: b.dl.map(l => d(l)),
        }
        if (ch.i === 'mortis' && mutsumiCh) {
          cfg.altId = 'mutsumi'
          cfg.altDisplayName = d(mutsumiCh.d)
          cfg.altColor = mutsumiCh.c
        }
        return cfg
      })
    const catSprites: SpriteConfig[] = _d.k.map(cat => ({
      id: cat.i,
      displayName: d(cat.d),
      color: cat.c,
      ...(cat.c2 != null ? { color2: cat.c2 as string } : {}),
      opacity: cat.op,
      speed: cat.sp,
      pauseChance: cat.pc,
      pauseDuration: [cat.pd[0], cat.pd[1]] as [number, number],
      bounceHeight: cat.bh,
      isCat: true,
      dialogues: cat.dl.map(l => d(l)),
    }))
    setSprites([...charSprites, ...catSprites])

    setFinalMsg({
      id: 'nozomu',
      fullName: d(_d.z.n),
      familyName: d(_d.z.f),
      givenName: d(_d.z.g),
      intimate: false,
      signal: d(_d.z.q),
      message: d(_d.z.m),
      color: '#D4600A',
    })

    setTagline(_d.t.map(l => d(l)))
    setEnding(((_d as any).ed ?? []).map((l: string) => d(l)))

    const catLookup = new Map<string, { name: string; color: string }>()
    for (const cat of _d.k) catLookup.set(cat.i, { name: d(cat.d), color: cat.c })
    for (const ch of _d.s) if ((ch as any).cat) catLookup.set(ch.i, { name: d(ch.d), color: ch.c })
    setCatCredits(
      ['watermelon', 'flatwhite', 'kamaboko', 'watermelon_ice', 'melon']
        .map(id => catLookup.get(id))
        .filter((c): c is { name: string; color: string } => !!c)
    )
  }, [])

  useEffect(() => {
    requestAnimationFrame(() => setVis(true))
    const t = setTimeout(() => setPhase('playing'), 3500)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  useEffect(() => {
    if (phase === 'entering') return
    const buf: string[] = []
    const onKey = async (e: KeyboardEvent) => {
      if (e.key.length !== 1 || e.key === 'Escape') return
      buf.push(e.key.toLowerCase())
      if (buf.length > 8) buf.shift()
      if (buf.length === 8 && await checkTrigger(buf.join(''))) setGlitch(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  return (
    <div
      className="egg-root fixed inset-0 z-[60]"
      style={{ backgroundColor: '#0a0f1a', opacity: vis ? 1 : 0, transition: 'opacity 1.5s ease-in' }}
    >
      <style>{CSS}</style>
      {phase !== 'entering' && stars.length > 0 && (
        <>
          <Sky />
          <Credits
            stars={stars}
            cats={catCredits}
            finalMsg={finalMsg}
            tagline={tagline}
            ending={ending}
            glitchEnabled={glitch}
            onFinale={handleFinale}
          />
          <Stage sprites={sprites} decryptionKey={keyRef.current} />
        </>
      )}
      {(phase === 'finale' || phase === 'idle') && (
        <button
          type="button"
          onClick={onClose}
          className="egg-fadein fixed right-6 top-6 z-[70] cursor-pointer border-none bg-transparent text-lg"
          style={{ color: '#c8bfb080', animationDelay: '2s', animationFillMode: 'backwards' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#c8bfb0' }}
          onMouseLeave={e => { e.currentTarget.style.color = '#c8bfb080' }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
