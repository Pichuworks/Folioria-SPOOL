import { describe, expect, it } from 'vitest'
import {
  formatMoney,
  formatMoneyC,
  lineTotal,
  money,
  moneyC,
  roundHalfUp,
  sumMoney,
  type Money,
  type MoneyC,
} from './money.js'

describe('§1.1 round_half_up（唯一指定舍入函数）', () => {
  const vectors: ReadonlyArray<readonly [number, number]> = [
    [23.31, 23],
    [23.5, 24],
    [2.5, 3],
    [0.4999, 0],
    [74.0, 74],
  ]
  it.each(vectors)('roundHalfUp(%f) → %i', (input, expected) => {
    expect(roundHalfUp(input)).toBe(expected)
  })

  it('IEEE754 双重舍入回归钉：0.49999999999999994 → 0（floor(n+0.5) 路线在此翻车）', () => {
    expect(roundHalfUp(0.49999999999999994)).toBe(0)
  })

  it.each([NaN, Infinity, -Infinity, -2.5, -0.0001, 2 ** 53 + 2])(
    '非法输入 %f → RangeError',
    (input) => {
      expect(() => roundHalfUp(input)).toThrow(RangeError)
    },
  )
})

describe('§1.2 行小计（唯一舍入点）line_total = round_half_up(unit_price_c × qty / 100)', () => {
  const vectors: ReadonlyArray<readonly [number, number, number]> = [
    [7, 200, 14],
    [7, 333, 23],
    [5, 50, 3],
    [90, 100, 90],
    [2500, 7, 175],
  ]
  it.each(vectors)('lineTotal(%i_c, %i) → %i', (unitPriceC, qty, expected) => {
    expect(lineTotal(moneyC(unitPriceC), qty)).toBe(expected)
  })

  it.each([0, -1, 1.5, NaN])('非法 qty %f → RangeError', (qty) => {
    expect(() => lineTotal(moneyC(7), qty)).toThrow(RangeError)
  })

  it.each([-1, -2500])('负单价 %i_c → RangeError（负 prod 令 half-up 语义崩坏）', (u) => {
    expect(() => lineTotal(moneyC(u), 10)).toThrow(RangeError)
  })

  it('乘积溢出安全整数 → RangeError', () => {
    expect(() => lineTotal(moneyC(Number.MAX_SAFE_INTEGER - 1), 2)).toThrow(RangeError)
  })

  it('确定性网格：divmod 实现与规范直译 roundHalfUp(u×q/100) 恒等（16 单价 × 2000 数量）', () => {
    const prices = [0, 1, 3, 5, 7, 49, 50, 51, 90, 99, 100, 101, 2500, 9999, 123456, 2060000]
    const mismatches: string[] = []
    for (const u of prices) {
      for (let q = 1; q <= 2000; q++) {
        const got = lineTotal(moneyC(u), q)
        const want = roundHalfUp((u * q) / 100)
        if (got !== want && mismatches.length < 5) {
          mismatches.push(`u=${u} q=${q} got=${got} want=${want}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe('§1.3 subtotal 守恒：整数加法，禁止对总额再舍入', () => {
  const subtotal = (items: ReadonlyArray<readonly [number, number]>): Money =>
    sumMoney(items.map(([u, q]) => lineTotal(moneyC(u), q)))

  it('订单 A（验收五行）→ 305', () => {
    const items = [
      [7, 200],
      [7, 333],
      [5, 50],
      [90, 100],
      [2500, 7],
    ] as const
    expect(subtotal(items)).toBe(14 + 23 + 3 + 90 + 175)
    expect(subtotal(items)).toBe(305)
  })

  it('订单 B（全平局五行）→ 18，且 ≠ 对总额再舍入的歧途值 16', () => {
    const items = [
      [5, 50],
      [5, 150],
      [25, 2],
      [15, 30],
      [1, 50],
    ] as const
    expect(subtotal(items)).toBe(3 + 8 + 1 + 5 + 1)
    const wrongPath = roundHalfUp((5 * 50 + 5 * 150 + 25 * 2 + 15 * 30 + 1 * 50) / 100)
    expect(wrongPath).toBe(16)
    expect(subtotal(items)).not.toBe(wrongPath)
  })

  it('订单 C（三条同平局行）→ 9，且 ≠ 歧途值 8', () => {
    const items = [
      [5, 50],
      [5, 50],
      [5, 50],
    ] as const
    expect(subtotal(items)).toBe(9)
    const wrongPath = roundHalfUp((5 * 50 * 3) / 100)
    expect(wrongPath).toBe(8)
    expect(subtotal(items)).not.toBe(wrongPath)
  })

  it('订单 D（空订单）→ 0', () => {
    expect(sumMoney([])).toBe(0)
  })
})

describe('§1.4 branded type 编译期隔离', () => {
  it('混算无法通过 tsc——执法点是 npm run typecheck（tsc --noEmit），vitest 不查类型', () => {
    const c: MoneyC = moneyC(7)
    const m: Money = money(14)

    // @ts-expect-error -- 验收点①：MoneyC + Money 混算得 number，不能回写 Money
    const bad1: Money = c + m
    // @ts-expect-error -- 验收点②：Money 直接乘数量得 number，不能当 Money 用
    const bad2: Money = m * 3
    // @ts-expect-error -- MoneyC 乘数量同样失去品牌，必须走 lineTotal()
    const bad3: MoneyC = c * 3
    // @ts-expect-error -- MoneyC + Money 也不能回写 MoneyC
    const bad4: MoneyC = c + m
    // @ts-expect-error -- Money + Money 裸加不能回写，汇总必须走 sumMoney()
    const bad5: Money = m + m
    // @ts-expect-error -- MoneyC + MoneyC 不能回写 MoneyC
    const bad6: MoneyC = c + c
    // @ts-expect-error -- Money 传入 MoneyC 参数位（金额层冒充单价层）
    lineTotal(m, 3)
    // @ts-expect-error -- MoneyC 数组不能传给 sumMoney（单价层禁止直接汇总）
    sumMoney([c])
    // @ts-expect-error -- 裸 number 字面量不能直接当 Money，必须 money() 构造
    const bad7: Money = 100
    // @ts-expect-error -- 裸 number 字面量不能直接当 MoneyC
    const bad8: MoneyC = 700
    // @ts-expect-error -- Money 与 MoneyC 不能互相赋值
    const bad9: MoneyC = m
    // @ts-expect-error -- 除法逃逸：Money / 100 得 number，禁止回写
    const bad10: Money = m / 100
    // @ts-expect-error -- Math.round 洗白无效：返回 number 不能回写 Money
    const bad11: Money = Math.round(m * 1.1)
    // @ts-expect-error -- Money 不能混入数量位（qty 为 Qty 反品牌）
    lineTotal(c, m)
    // @ts-expect-error -- MoneyC 不能混入数量位
    lineTotal(c, c)
    // @ts-expect-error -- 构造器拒绝跨层再品牌化：Money 不能经 moneyC() 洗成单价层
    moneyC(m)
    // @ts-expect-error -- 构造器拒绝跨层再品牌化：MoneyC 不能经 money() 洗成金额层
    money(c)

    void [bad1, bad2, bad3, bad4, bad5, bad6, bad7, bad8, bad9, bad10, bad11]

    // 正向：受祝福路径必须可编译（防类型收得过死）
    const total: Money = lineTotal(c, 200)
    const qtyVar: number = 333
    const totalVar: Money = lineTotal(c, qtyVar)
    const sub: Money = sumMoney([total, m])
    const widen: number = m
    void widen

    expect(total).toBe(14)
    expect(totalVar).toBe(23)
    expect(sub).toBe(28)
  })
})

describe('formatMoney（PRD §7：全系统唯一允许除法的函数）', () => {
  const JPY = { symbol: '¥', decimal_places: 0 }
  const USD = { symbol: '$', decimal_places: 2 }
  const CNY = { symbol: '￥', decimal_places: 2 }
  const KWD = { symbol: 'KD', decimal_places: 3 }

  const vectors: ReadonlyArray<
    readonly [number, { symbol: string; decimal_places: number }, string]
  > = [
    [3400, JPY, '¥3,400'],
    [3400, USD, '$34.00'],
    [3400, CNY, '￥34.00'],
    [0, JPY, '¥0'],
    [0, USD, '$0.00'],
    [5, USD, '$0.05'],
    [-1, JPY, '-¥1'],
    [-150, USD, '-$1.50'],
    [-1234567, CNY, '-￥12,345.67'],
    [100, JPY, '¥100'],
    [1000, JPY, '¥1,000'],
    [1234567890, JPY, '¥1,234,567,890'],
    [1234567, KWD, 'KD1,234.567'],
  ]
  it.each(vectors)('formatMoney(%i, %o) → %s', (amount, currency, expected) => {
    expect(formatMoney(money(amount), currency)).toBe(expected)
  })

  it.each([-1, 1.5, 7])('非法 decimal_places %f → RangeError', (dp) => {
    expect(() => formatMoney(money(100), { symbol: '¥', decimal_places: dp })).toThrow(RangeError)
  })
})

describe('formatMoneyC（单价层 _c 展示，T08 计算器消费）', () => {
  const JPY = { symbol: '¥', decimal_places: 0 }
  const USD = { symbol: '$', decimal_places: 2 }

  const vectors: ReadonlyArray<
    readonly [number, { symbol: string; decimal_places: number }, string]
  > = [
    [7, JPY, '¥0.07'],
    [225, JPY, '¥2.25'],
    [2500, JPY, '¥25'],
    [90, JPY, '¥0.9'],
    [0, JPY, '¥0'],
    [7646, JPY, '¥76.46'],
    [1234567, JPY, '¥12,345.67'],
    [700, USD, '$0.07'],
    [340000, USD, '$34.00'],
    [12345, USD, '$1.2345'],
    [-74, JPY, '-¥0.74'],
  ]
  it.each(vectors)('formatMoneyC(%i, %o) → %s', (priceC, currency, expected) => {
    expect(formatMoneyC(moneyC(priceC), currency)).toBe(expected)
  })
})

describe('构造器与防御性守卫', () => {
  it.each([1.5, NaN, Infinity, -Infinity, 2 ** 53])('money/moneyC 拒绝非安全整数 %f', (n) => {
    expect(() => money(n)).toThrow(RangeError)
    expect(() => moneyC(n)).toThrow(RangeError)
  })

  it('构造器允许负数（jobs.profit、_c 层毛利差），符号约束归 schema/API 层', () => {
    expect(money(-150)).toBe(-150)
    expect(moneyC(-74)).toBe(-74)
  })

  it('品牌可被 as 伪造，运行时守卫仍拦截（防御纵深）', () => {
    const forged = 1.5 as unknown as Money
    expect(() => sumMoney([forged])).toThrow(RangeError)
    expect(() => formatMoney(forged, { symbol: '$', decimal_places: 2 })).toThrow(RangeError)
  })
})
