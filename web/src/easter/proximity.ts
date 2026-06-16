import type { SpriteInstance } from './types'

const THRESHOLD = 40

export function findNearPairs(
  sprites: SpriteInstance[],
  threshold = THRESHOLD,
): [number, number][] {
  const result: [number, number][] = []
  for (let i = 0; i < sprites.length; i++) {
    for (let j = i + 1; j < sprites.length; j++) {
      if (Math.abs(sprites[i]!.x - sprites[j]!.x) < threshold) {
        result.push([i, j])
      }
    }
  }
  return result
}
