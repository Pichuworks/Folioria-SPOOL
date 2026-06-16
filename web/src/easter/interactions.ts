import { decode } from './codec'
import { _d } from './payload'
import { findNearPairs } from './proximity'
import type { SpriteInstance } from './types'

export interface PairRule {
  a: string
  b: string
  aDialogue: string
  bDialogue: string
  chance: number
  cooldown: number
}

export interface CatRule {
  cat: string
  target: string
  dialogue: string
  chance: number
  cooldown: number
}

export interface SoloRule {
  id: string
  type: 'long_pause' | 'sprint' | 'big_bounce'
}

export interface GroupEvent {
  type: 'cats_stop' | 'nyamu_dash'
  chance: number
  cooldown: number
}

interface DecodedRules {
  pairs: PairRule[]
  cats: CatRule[]
  solos: SoloRule[]
  groups: GroupEvent[]
}

export function loadRules(key: string): DecodedRules {
  const d = (s: string) => decode(s, key)

  const pairs: PairRule[] = ((_d as any).ix ?? []).map((r: any) => ({
    a: r.a, b: r.b,
    aDialogue: d(r.ad), bDialogue: d(r.bd),
    chance: r.ch, cooldown: r.cd,
  }))

  const cats: CatRule[] = ((_d as any).cx ?? []).map((r: any) => ({
    cat: r.cat, target: r.tgt,
    dialogue: d(r.td),
    chance: r.ch, cooldown: r.cd,
  }))

  const solos: SoloRule[] = ((_d as any).so ?? []).map((r: any) => ({
    id: r.id, type: r.ty,
  }))

  const groups: GroupEvent[] = ((_d as any).ge ?? []).map((r: any) => ({
    type: r.ty, chance: r.ch, cooldown: r.cd,
  }))

  return { pairs, cats, solos, groups }
}

export class InteractionEngine {
  private rules: DecodedRules
  private pairCooldowns = new Map<number, number>()
  private catCooldowns = new Map<number, number>()
  private groupCooldowns = new Map<number, number>()
  private soloCooldowns = new Map<string, number>()
  private idIndex = new Map<string, number>()
  private catIds = new Set<string>()

  constructor(rules: DecodedRules, sprites: SpriteInstance[]) {
    this.rules = rules
    this.rebuild(sprites)
  }

  rebuild(sprites: SpriteInstance[]) {
    this.idIndex.clear()
    this.catIds.clear()
    for (let i = 0; i < sprites.length; i++) {
      this.idIndex.set(sprites[i]!.cfg.id, i)
      if (sprites[i]!.cfg.isCat) this.catIds.add(sprites[i]!.cfg.id)
    }
  }

  tick(sprites: SpriteInstance[], dt: number) {
    this.tickPairs(sprites, dt)
    this.tickCats(sprites, dt)
    this.tickSolos(sprites, dt)
    this.tickGroups(sprites, dt)
  }

  private tickPairs(sprites: SpriteInstance[], dt: number) {
    for (const [key, v] of this.pairCooldowns) {
      this.pairCooldowns.set(key, v - dt)
    }

    const near = findNearPairs(sprites)
    for (const [i, j] of near) {
      const si = sprites[i]!, sj = sprites[j]!
      if (si.state === 'interact' || sj.state === 'interact') continue
      if (si.state === 'solo' || sj.state === 'solo') continue

      const idA = si.cfg.id, idB = sj.cfg.id
      for (let ri = 0; ri < this.rules.pairs.length; ri++) {
        const rule = this.rules.pairs[ri]!
        const cd = this.pairCooldowns.get(ri) ?? 0
        if (cd > 0) continue

        let aIdx = -1, bIdx = -1
        if (rule.a === idA && rule.b === idB) { aIdx = i; bIdx = j }
        else if (rule.a === idB && rule.b === idA) { aIdx = j; bIdx = i }
        if (aIdx < 0) continue

        if (Math.random() > rule.chance) continue

        this.pairCooldowns.set(ri, rule.cooldown)
        this.triggerInteract(sprites[aIdx]!, rule.aDialogue)
        this.triggerInteract(sprites[bIdx]!, rule.bDialogue)
        break
      }
    }
  }

  private tickCats(sprites: SpriteInstance[], dt: number) {
    for (const [key, v] of this.catCooldowns) {
      this.catCooldowns.set(key, v - dt)
    }

    const near = findNearPairs(sprites)
    for (const [i, j] of near) {
      const si = sprites[i]!, sj = sprites[j]!
      const catSide = si.cfg.isCat ? 'i' : sj.cfg.isCat ? 'j' : null
      if (!catSide) continue

      const catSprite = catSide === 'i' ? si : sj
      const targetSprite = catSide === 'i' ? sj : si
      if (targetSprite.cfg.isCat) continue
      if (targetSprite.state === 'interact' || targetSprite.state === 'solo') continue

      for (let ri = 0; ri < this.rules.cats.length; ri++) {
        const rule = this.rules.cats[ri]!
        const cd = this.catCooldowns.get(ri) ?? 0
        if (cd > 0) continue

        const catMatch = rule.cat === '*' || rule.cat === catSprite.cfg.id
        if (!catMatch || rule.target !== targetSprite.cfg.id) continue

        if (Math.random() > rule.chance) continue

        this.catCooldowns.set(ri, rule.cooldown)
        this.triggerInteract(targetSprite, rule.dialogue)
        break
      }
    }
  }

  private tickSolos(sprites: SpriteInstance[], _dt: number) {
    for (const rule of this.rules.solos) {
      const idx = this.idIndex.get(rule.id)
      if (idx == null) continue
      const s = sprites[idx]!
      if (s.state !== 'walk' && s.state !== 'idle') continue

      const cd = this.soloCooldowns.get(rule.id) ?? 0
      if (cd > 0) {
        this.soloCooldowns.set(rule.id, cd - _dt)
        continue
      }

      if (Math.random() > 0.001) continue

      this.soloCooldowns.set(rule.id, 20)
      s.state = 'solo'
      s.stateTimer = 0

      if (rule.type === 'long_pause') {
        s.soloType = 'long_pause'
        s.soloDuration = 8 + Math.random() * 7
      } else if (rule.type === 'sprint') {
        s.soloType = 'sprint'
        s.soloDuration = 2 + Math.random()
      } else if (rule.type === 'big_bounce') {
        s.soloType = 'big_bounce'
        s.soloDuration = 3 + Math.random() * 2
      }
    }
  }

  private tickGroups(sprites: SpriteInstance[], dt: number) {
    for (let gi = 0; gi < this.rules.groups.length; gi++) {
      const ge = this.rules.groups[gi]!
      const cd = this.groupCooldowns.get(gi) ?? 0
      if (cd > 0) {
        this.groupCooldowns.set(gi, cd - dt)
        continue
      }

      if (Math.random() > ge.chance) continue

      this.groupCooldowns.set(gi, ge.cooldown)

      if (ge.type === 'cats_stop') {
        for (const s of sprites) {
          if (!s.cfg.isCat) continue
          s.state = 'idle'
          s.stateTimer = 0
          s.pauseDuration = 3
        }
      } else if (ge.type === 'nyamu_dash') {
        const idx = this.idIndex.get('nyamu')
        if (idx != null) {
          const s = sprites[idx]!
          s.state = 'solo'
          s.stateTimer = 0
          s.soloType = 'sprint'
          s.soloDuration = 4
        }
      }
    }
  }

  private triggerInteract(s: SpriteInstance, dialogue: string) {
    s.state = 'interact'
    s.stateTimer = 0
    s.bubble = dialogue
    s.bubbleTimer = 2.8
  }
}
