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
}

export type Phase = 'entering' | 'playing' | 'finale' | 'idle'

export type SpriteMotion = 'walk' | 'idle' | 'solo' | 'interact'

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
  soloType: 'long_pause' | 'sprint' | 'big_bounce' | null
  soloDuration: number
}
