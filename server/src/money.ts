declare const moneyCBrand: unique symbol
declare const moneyBrand: unique symbol

/** 单价层：最小货币单位 × 100（字段后缀 _c） */
export type MoneyC = number & { readonly [moneyCBrand]: true }
/** 金额层：最小货币单位整数 */
export type Money = number & { readonly [moneyBrand]: true }
/** 裸数量：拒绝任何品牌化金额混入数量位 */
export type Qty = number & {
  readonly [moneyCBrand]?: never
  readonly [moneyBrand]?: never
}

export interface Currency {
  code: string
  symbol: string
  decimal_places: number
}

export function moneyC(n: Qty): MoneyC {
  if (!Number.isSafeInteger(n)) throw new RangeError(`moneyC: not a safe integer: ${n}`)
  return n as MoneyC
}

export function money(n: Qty): Money {
  if (!Number.isSafeInteger(n)) throw new RangeError(`money: not a safe integer: ${n}`)
  return n as Money
}

/** 唯一指定舍入函数。Math.round 而非 floor(n+0.5)：后者在 0.49999999999999994 处双重舍入翻车 */
export function roundHalfUp(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError(`roundHalfUp: non-finite input: ${n}`)
  if (n < 0) throw new RangeError(`roundHalfUp: negative input: ${n}`)
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`roundHalfUp: input exceeds safe integer range: ${n}`)
  }
  return Math.round(n)
}

/** 唯一舍入点：round_half_up(unit_price_c × qty / 100) 的整数 divmod 实现，浮点不经手金额 */
export function lineTotal(unitPriceC: MoneyC, qty: Qty): Money {
  if (!Number.isSafeInteger(unitPriceC) || unitPriceC < 0) {
    throw new RangeError(`lineTotal: invalid unit price: ${unitPriceC}`)
  }
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new RangeError(`lineTotal: qty must be a positive integer: ${qty}`)
  }
  const prod = unitPriceC * qty
  if (!Number.isSafeInteger(prod)) {
    throw new RangeError('lineTotal: product exceeds safe integer range')
  }
  const rem = prod % 100
  const base = (prod - rem) / 100
  return (rem >= 50 ? base + 1 : base) as Money
}

export function sumMoney(values: readonly Money[]): Money {
  let total = 0
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new RangeError(`sumMoney: not a safe integer: ${v}`)
    total += v
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('sumMoney: sum exceeds safe integer range')
    }
  }
  return total as Money
}

/** 全系统唯一允许除法的函数（铁律 2）；divmod 精确整除，零浮点 */
export function formatMoney(
  amount: Money,
  currency: Pick<Currency, 'symbol' | 'decimal_places'>,
): string {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`formatMoney: not a safe integer: ${amount}`)
  }
  const dp = currency.decimal_places
  if (!Number.isSafeInteger(dp) || dp < 0 || dp > 6) {
    throw new RangeError(`formatMoney: invalid decimal_places: ${dp}`)
  }
  const negative = amount < 0
  const abs = negative ? -amount : amount
  const factor = 10 ** dp
  const frac = abs % factor
  const whole = (abs - frac) / factor
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+$)/g, ',')
  const fracStr = dp === 0 ? '' : `.${String(frac).padStart(dp, '0')}`
  return `${negative ? '-' : ''}${currency.symbol}${wholeStr}${fracStr}`
}
