export interface StarEntry {
  id: string
  fullName: string
  familyName: string
  givenName: string
  intimate: boolean
  signal: string
  message: string
  color: string
}

export interface SpriteConfig {
  id: string
  displayName: string
  color: string
  color2?: string
  opacity?: number
  speed: number
  pauseChance: number
  pauseDuration: [number, number]
  bounceHeight: number
  isCat?: boolean
  dialogues: string[]
  altId?: string
  altDisplayName?: string
  altColor?: string
}

export type Phase = 'entering' | 'playing' | 'finale' | 'idle'

export type SpriteMotion = 'walk' | 'idle' | 'solo' | 'interact'

export type SoloType =
  | 'long_pause' | 'sprint' | 'big_bounce'
  | 'pause' | 'sequence' | 'turn' | 'spin' | 'cat_antics'
  | null

/**
 * payload.ts(@generated) 互动段的原始结构（codec 解码前的字段缩写形状）。
 * 集中声明以替代 interactions.ts / Overlay.tsx 中散落的 `as any`（review L-easter）。
 * 字段缺省可空：旧 payload 不含某段时 `?? []` 兜底，行为与原 `as any` 完全一致。
 */
export interface RawPayload {
  ix?: Array<{ a: string; b: string; ad: string; bd: string; ch: number; cd: number }>
  cx?: Array<{ cat: string; tgt: string; td: string; ch: number; cd: number }>
  so?: Array<{ id: string; ty: string; dl?: string[] }>
  ge?: Array<{ ty: string; ch: number; cd: number }>
  ed?: string[]
}

export interface SpriteInstance {
  cfg: SpriteConfig
  x: number
  state: SpriteMotion
  facingRight: boolean
  stateTimer: number
  walkDuration: number
  pauseDuration: number
  bouncePhase: number
  bubble: string | null
  bubbleTimer: number
  soloYOffset: number
  soloType: SoloType
  soloDuration: number
  soloBubbles: string[]
  soloBubbleIdx: number
  isAlt: boolean
  switchTimer: number
}
