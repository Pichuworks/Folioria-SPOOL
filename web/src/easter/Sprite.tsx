import type { SpriteInstance } from './types'

export default function Sprite({ s }: { s: SpriteInstance }) {
  const { cfg, x, facingRight, bouncePhase, bubble, soloYOffset, state, isAlt } = s
  const moveSolo = s.soloType === 'sprint' || s.soloType === 'big_bounce' || s.soloType === 'cat_antics'
  const bouncing = state === 'walk' || (state === 'solo' && moveSolo)
  const bounceY = bouncing ? Math.sin(bouncePhase) * cfg.bounceHeight : 0

  const displayName = isAlt && cfg.altDisplayName ? cfg.altDisplayName : cfg.displayName
  const displayColor = isAlt && cfg.altColor ? cfg.altColor : cfg.color

  const hasDual = !!cfg.color2
  const bg = hasDual
    ? `linear-gradient(90deg, ${cfg.color} 50%, ${cfg.color2} 50%)`
    : displayColor

  return (
    <div
      className="absolute"
      style={{
        left: x,
        bottom: 10,
        transform: `translateY(${-bounceY + soloYOffset}px)`,
      }}
    >
      <div
        className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[7px] tracking-[.08em]"
        style={{ color: displayColor, opacity: 0.45 }}
      >
        {displayName}
      </div>
      <div
        style={{
          width: 16,
          height: 16,
          background: bg,
          opacity: cfg.opacity ?? 1,
          imageRendering: 'pixelated' as const,
          transform: `scaleX(${facingRight ? 1 : -1})`,
        }}
      />
      {bubble && (
        <div
          className="egg-bubble absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px]"
          style={{ color: '#f5e6c8' }}
        >
          {bubble}
        </div>
      )}
    </div>
  )
}
