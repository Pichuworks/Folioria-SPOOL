import { moneyC, roundHalfUp, type MoneyC } from './money.js'

export type FinishingPricing = 'per_book' | 'per_page' | 'per_area'

export interface FinishingSpec {
  pricing: FinishingPricing
  price_c: number
}

export interface FinishingContext {
  pages: number
  area: number
}

export function finishingContribution(f: FinishingSpec, ctx: FinishingContext): MoneyC {
  if (f.pricing === 'per_book') return moneyC(f.price_c)
  if (f.pricing === 'per_page') return moneyC(f.price_c * ctx.pages)
  return moneyC(roundHalfUp(f.price_c * ctx.area))
}
