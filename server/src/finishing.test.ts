import { describe, expect, it } from 'vitest'
import { finishingContribution } from './finishing.js'

describe('finishingContribution', () => {
  it('per_book: flat price_c regardless of pages/area', () => {
    expect(finishingContribution({ pricing: 'per_book', price_c: 500 }, { pages: 10, area: 2.5 })).toBe(500)
  })

  it('per_page: price_c × pages', () => {
    expect(finishingContribution({ pricing: 'per_page', price_c: 30 }, { pages: 4, area: 1.0 })).toBe(120)
  })

  it('per_area: roundHalfUp(price_c × area)', () => {
    // 100 × 1.5 = 150.0 → 150
    expect(finishingContribution({ pricing: 'per_area', price_c: 100 }, { pages: 1, area: 1.5 })).toBe(150)
    // 100 × 2.5 = 250.0 → 250
    expect(finishingContribution({ pricing: 'per_area', price_c: 100 }, { pages: 1, area: 2.5 })).toBe(250)
    // 7 × 1.3 = 9.1 → 9 (round half up, .1 < .5)
    expect(finishingContribution({ pricing: 'per_area', price_c: 7 }, { pages: 1, area: 1.3 })).toBe(9)
    // 5 × 1.5 = 7.5 → 8 (half up)
    expect(finishingContribution({ pricing: 'per_area', price_c: 5 }, { pages: 1, area: 1.5 })).toBe(8)
  })
})
