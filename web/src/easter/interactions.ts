import { decode } from './codec'
import { _d } from './payload'
import { findNearPairs } from './proximity'
import type { SoloType, SpriteInstance } from './types'

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
  type: string
  dialogues: string[]
}

export interface GroupEvent {
  type: string
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
    dialogues: (r.dl ?? []).map((l: string) => d(l)),
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

  private tickSolos(sprites: SpriteInstance[], dt: number) {
    for (const rule of this.rules.solos) {
      const idx = this.idIndex.get(rule.id)
      if (idx == null) continue
      const s = sprites[idx]!
      if (s.state !== 'walk' && s.state !== 'idle') continue

      const cd = this.soloCooldowns.get(rule.id) ?? 0
      if (cd > 0) {
        this.soloCooldowns.set(rule.id, cd - dt)
        continue
      }

      if (Math.random() > 0.001) continue

      this.soloCooldowns.set(rule.id, 20)
      s.state = 'solo'
      s.stateTimer = 0
      s.soloBubbles = rule.dialogues
      s.soloBubbleIdx = 0

      const ty = rule.type as SoloType
      s.soloType = ty

      if (ty === 'long_pause') {
        s.soloDuration = 8 + Math.random() * 7
      } else if (ty === 'sprint') {
        s.soloDuration = 2 + Math.random()
      } else if (ty === 'big_bounce') {
        s.soloDuration = 3 + Math.random() * 2
      } else if (ty === 'pause') {
        s.soloDuration = 3 + Math.random() * 2
      } else if (ty === 'sequence') {
        s.soloDuration = rule.dialogues.length * 1.2 + 1
      } else if (ty === 'turn') {
        s.soloDuration = 3 + Math.random()
      } else if (ty === 'spin') {
        s.soloDuration = 1.5 + Math.random()
      } else if (ty === 'cat_antics') {
        s.soloDuration = 1.5 + Math.random()
      }

      if (rule.dialogues.length > 0) {
        s.bubble = rule.dialogues[0]!
        s.bubbleTimer = ty === 'sequence' ? 1.0 : s.soloDuration
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

      if (ge.type === 'cats_stop') {
        if (Math.random() > ge.chance) continue
        this.groupCooldowns.set(gi, ge.cooldown)
        for (const s of sprites) {
          if (!s.cfg.isCat) continue
          s.state = 'idle'
          s.stateTimer = 0
          s.pauseDuration = 3
        }
      } else if (ge.type === 'volume_warning') {
        if (!this.checkCluster(sprites, ['keke', 'nyamu'], 50)) continue
        if (Math.random() > ge.chance) continue
        const third = this.findNearbyBystander(sprites, ['keke', 'nyamu'], 60)
        if (!third) continue
        this.groupCooldowns.set(gi, ge.cooldown)
        this.triggerInteractById(sprites, 'keke', '！！！')
        this.triggerInteractById(sprites, 'nyamu', '！！！')
        this.triggerInteract(third, '……')
      } else if (ge.type === 'crychic') {
        const members = ['tomori', 'soyo', 'mutsumi', 'taki', 'sakiko']
        if (!this.checkCluster(sprites, members, 80)) continue
        if (Math.random() > ge.chance) continue
        this.groupCooldowns.set(gi, ge.cooldown)
        for (const id of members) this.triggerInteractById(sprites, id, '♪')
      } else if (ge.type === 'mygo') {
        const members = ['tomori', 'anon', 'taki', 'soyo', 'raana']
        if (!this.checkCluster(sprites, members, 80)) continue
        if (Math.random() > ge.chance) continue
        this.groupCooldowns.set(gi, ge.cooldown)
        for (const id of members) {
          const b = id === 'anon' ? '！' : id === 'taki' ? '…' : '♪'
          this.triggerInteractById(sprites, id, b)
        }
      } else if (ge.type === 'meeting') {
        const members = ['mana', 'uika', 'sakiko']
        if (!this.checkCluster(sprites, members, 60)) continue
        if (Math.random() > ge.chance) continue
        this.groupCooldowns.set(gi, ge.cooldown)
        for (const id of members) {
          this.triggerInteractById(sprites, id, id === 'uika' ? '！' : '…')
        }
      }
    }
  }

  private checkCluster(sprites: SpriteInstance[], ids: string[], threshold: number): boolean {
    let minX = Infinity, maxX = -Infinity
    for (const id of ids) {
      const idx = this.idIndex.get(id)
      if (idx == null) return false
      const s = sprites[idx]!
      if (s.state === 'interact' || s.state === 'solo') return false
      if (s.x < minX) minX = s.x
      if (s.x > maxX) maxX = s.x
    }
    return (maxX - minX) < threshold
  }

  private findNearbyBystander(sprites: SpriteInstance[], exclude: string[], range: number): SpriteInstance | null {
    let cx = 0, n = 0
    for (const id of exclude) {
      const idx = this.idIndex.get(id)
      if (idx != null) { cx += sprites[idx]!.x; n++ }
    }
    if (n === 0) return null
    cx /= n
    for (const s of sprites) {
      if (exclude.includes(s.cfg.id) || s.cfg.isCat) continue
      if (s.state === 'interact' || s.state === 'solo') continue
      if (Math.abs(s.x - cx) < range) return s
    }
    return null
  }

  private triggerInteractById(sprites: SpriteInstance[], id: string, dialogue: string) {
    const idx = this.idIndex.get(id)
    if (idx != null) this.triggerInteract(sprites[idx]!, dialogue)
  }

  private triggerInteract(s: SpriteInstance, dialogue: string) {
    s.state = 'interact'
    s.stateTimer = 0
    s.bubble = dialogue
    s.bubbleTimer = 2.8
  }
}
