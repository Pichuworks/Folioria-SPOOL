import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookError, priceBook } from './books.js'
import { type DB } from './db.js'
import { lineTotal, moneyC } from './money.js'
import { importSeed } from './seed.js'
import { makeTestDb, withSystemConfig } from './test-helpers.js'

/**
 * D27 书定价（seed 基准）。已知单页价（priceComponentSpec 折叠最低）：
 *   bw  · paper 1 亚太森博 · A4 · 单 → 700_c   (mode 1)
 *   color · paper 6 哑光铜版纸 · A3 · 单 → 8313_c  (mode 4)
 *   color · paper 8 不干胶光面 · A4 · 单 → 6000_c  (mode 6)
 *   photo-art · paper 11 RC艺术纸 · A3 · 单 → 250000_c (mode 7)
 * 尺寸面积：A4 = 97，A3 = 193。
 */

let db: DB
beforeEach(() => {
  db = makeTestDb()
  withSystemConfig(db)
  importSeed(db)
})
afterEach(() => {
  db.close()
})

function makeBook(name: string): number {
  return Number(db.prepare('INSERT INTO book_products (name) VALUES (?)').run(name).lastInsertRowid)
}
function addComp(
  bookId: number,
  role: 'cover' | 'inner' | 'insert',
  paperId: number,
  sizeKey: string,
  colorClass: string,
  duplex = 0,
  sort = 0,
): number {
  return Number(
    db
      .prepare(
        'INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?,?,?,?,?,?,?)',
      )
      .run(bookId, role, paperId, sizeKey, colorClass, duplex, sort).lastInsertRowid,
  )
}
function addFinishing(name: string, pricing: 'per_book' | 'per_page' | 'per_area', priceC: number): number {
  return Number(
    db.prepare('INSERT INTO finishing_ops (name, pricing, price_c) VALUES (?,?,?)').run(name, pricing, priceC)
      .lastInsertRowid,
  )
}
function attach(bookId: number, finishingId: number): void {
  db.prepare('INSERT INTO book_finishings (book_id, finishing_id) VALUES (?,?)').run(bookId, finishingId)
}

describe('priceBook — 组件解析 + 每本单价装配', () => {
  it('封面 + 内页：unit_price = Σ(单页价×每本张数)，封面固定 1 张', () => {
    const book = makeBook('test-zine')
    const cover = addComp(book, 'cover', 6, 'A3', 'color', 0, 0)
    const inner = addComp(book, 'inner', 1, 'A4', 'bw', 0, 1)

    const q = priceBook(db, { book_id: book, count: 5, sheets: { [inner]: 10 } })
    // 组件：封面 8313×1 + 内页 700×10 = 8313 + 7000 = 15313
    expect(q.unit_price_c).toBe(15313)
    expect(q.components).toHaveLength(2)
    const coverC = q.components.find((c) => c.component_id === cover)!
    expect(coverC.sheets_per_book).toBe(1)
    expect(coverC.unit_sell_c).toBe(8313)
    expect(coverC.mode_id).toBe(4) // 机器解析（admin 用，客户不可见）
    const innerC = q.components.find((c) => c.component_id === inner)!
    expect(innerC.sheets_per_book).toBe(10)
    expect(innerC.unit_sell_c).toBe(700)
  })

  it('line_total = lineTotal(unit_price_c, count)（唯一舍入点）', () => {
    const book = makeBook('round-zine')
    const cover = addComp(book, 'cover', 6, 'A3', 'color')
    const inner = addComp(book, 'inner', 1, 'A4', 'bw', 0, 1)
    const bind = addFinishing('骑马钉', 'per_book', 2000)
    const number = addFinishing('页码', 'per_page', 3)
    attach(book, bind)
    attach(book, number)

    const q = priceBook(db, { book_id: book, count: 5, sheets: { [inner]: 10 } })
    // 组件 15313 + per_book 2000 + per_page 3×(1+10=11)=33 → unit 17346
    expect(q.unit_price_c).toBe(17346)
    // lineTotal(17346, 5) = round_half_up(86730/100) = 867
    expect(lineTotal(moneyC(17346), 5)).toBe(867)
    void cover
  })
})

describe('priceBook — 工艺三计价口径', () => {
  it('per_book = price_c（与张数/本数无关，每本固定）', () => {
    const book = makeBook('pb')
    addComp(book, 'cover', 6, 'A3', 'color')
    const f = addFinishing('精装', 'per_book', 1500)
    attach(book, f)
    const q = priceBook(db, { book_id: book, count: 3, sheets: {} })
    // 8313 + 1500 = 9813
    expect(q.unit_price_c).toBe(9813)
    expect(q.finishings[0]!.contribution_c).toBe(1500)
  })

  it('per_page = price_c × 每本页数（页 = Σ张×(duplex?2:1)，D21 impression）', () => {
    const book = makeBook('pp')
    const inner = addComp(book, 'inner', 8, 'A4', 'color', 0) // 单面 → 每张 1 页
    const f = addFinishing('压痕', 'per_page', 10)
    attach(book, f)
    const q = priceBook(db, { book_id: book, count: 2, sheets: { [inner]: 3 } })
    // 组件 6000×3 = 18000；页数 3；per_page 10×3 = 30 → unit 18030
    expect(q.unit_price_c).toBe(18030)
    expect(q.finishings[0]!.contribution_c).toBe(30)
  })

  it('per_area = roundHalfUp(price_c × 每本纸面积)（面积 = Σ size.area×张）', () => {
    const book = makeBook('pa')
    const inner = addComp(book, 'inner', 8, 'A4', 'color') // A4 area 97
    const f = addFinishing('覆膜', 'per_area', 5)
    attach(book, f)
    const q = priceBook(db, { book_id: book, count: 1, sheets: { [inner]: 4 } })
    // 组件 6000×4 = 24000；面积 97×4 = 388；per_area 5×388 = 1940 → unit 25940
    expect(q.unit_price_c).toBe(25940)
    expect(q.finishings[0]!.contribution_c).toBe(1940)
  })
})

describe('priceBook — 张数语义与可选性', () => {
  it('插图选填：缺省 → 不含该组件、不计价', () => {
    const book = makeBook('opt-insert')
    addComp(book, 'cover', 6, 'A3', 'color')
    const inner = addComp(book, 'inner', 1, 'A4', 'bw', 0, 1)
    const insert = addComp(book, 'insert', 11, 'A3', 'photo-art', 0, 2)

    const without = priceBook(db, { book_id: book, count: 1, sheets: { [inner]: 10 } })
    expect(without.components).toHaveLength(2) // 仅封面 + 内页
    expect(without.unit_price_c).toBe(15313)

    const withInsert = priceBook(db, { book_id: book, count: 1, sheets: { [inner]: 10, [insert]: 2 } })
    expect(withInsert.components).toHaveLength(3)
    // 15313 + 250000×2 = 515313
    expect(withInsert.unit_price_c).toBe(515313)
  })

  it('内页必填：缺张数 → 422 inner_sheets_required', () => {
    const book = makeBook('need-inner')
    addComp(book, 'cover', 6, 'A3', 'color')
    const inner = addComp(book, 'inner', 1, 'A4', 'bw', 0, 1)
    expect(() => priceBook(db, { book_id: book, count: 1, sheets: {} })).toThrow(BookError)
    try {
      priceBook(db, { book_id: book, count: 1, sheets: {} })
    } catch (e) {
      expect((e as BookError).message).toBe(`inner_sheets_required_${inner}`)
      expect((e as BookError).statusCode).toBe(422)
    }
  })

  it('成品不存在 / 已归档 → 422 book_not_available', () => {
    expect(() => priceBook(db, { book_id: 9999, count: 1, sheets: {} })).toThrow(/book_not_available/)
    const book = makeBook('arch')
    addComp(book, 'cover', 6, 'A3', 'color')
    db.prepare('UPDATE book_products SET archived = 1 WHERE id = ?').run(book)
    expect(() => priceBook(db, { book_id: book, count: 1, sheets: {} })).toThrow(/book_not_available/)
  })

  it('组件规格不可做（无产品）→ 422 component_not_quotable', () => {
    const book = makeBook('bad-comp')
    // color × paper 7 铜版157g @ A4：无 A4 采购口径（§2.4）→ 无产品
    const bad = addComp(book, 'cover', 7, 'A4', 'color')
    expect(() => priceBook(db, { book_id: book, count: 1, sheets: {} })).toThrow(
      new RegExp(`component_not_quotable_${bad}`),
    )
  })
})

describe('priceBook — 内部价（member）口径', () => {
  it('internal 走 internal_sell_c（缺省回落对外）；与对外口径独立', () => {
    const book = makeBook('intl')
    const inner = addComp(book, 'inner', 1, 'A4', 'bw', 0, 0)
    db.prepare("UPDATE combo_prices SET internal_sell_c = 500 WHERE combo_id = 1 AND size_key = 'A4'").run()
    const ext = priceBook(db, { book_id: book, count: 1, sheets: { [inner]: 10 } })
    const intl = priceBook(db, { book_id: book, count: 1, sheets: { [inner]: 10 } }, { internal: true })
    expect(ext.unit_price_c).toBe(7000) // 700×10
    expect(intl.unit_price_c).toBe(5000) // 500×10
  })
})
