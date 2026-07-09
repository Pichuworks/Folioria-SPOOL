import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDb, type DB } from './db.js'

const SCHEMA_PATH = fileURLToPath(new URL('../../docs/schema.sql', import.meta.url))
const MIGRATION_0001_PATH = fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url))

describe('migration runner', () => {
  let db: DB
  beforeEach(() => {
    db = openDb(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  it('0001_init.sql 与 docs/schema.sql 字节级一致（分歧守卫——schema 变更必须走新 migration）', () => {
    const schema = readFileSync(SCHEMA_PATH)
    const migration = readFileSync(MIGRATION_0001_PATH)
    expect(migration.equals(schema)).toBe(true)
  })

  it('migrate 应用全部 migration 后 user_version=最新，重复执行幂等', () => {
    expect(migrate(db)).toBe(35)
    expect(db.pragma('user_version', { simple: true })).toBe(35)
    expect(migrate(db)).toBe(0)
    expect(db.pragma('user_version', { simple: true })).toBe(35)
  })

  it('0035：已切 CNY 的配置类单价层从 RMB×100 补正为分×100', () => {
    migrate(db)
    db.prepare(
      "INSERT INTO system_config (id, base_currency, initialized_at) VALUES (1, 'CNY', '2026-07-09T00:00:00Z')",
    ).run()
    db.prepare("INSERT INTO sizes (key, label, area, sort) VALUES ('A4', 'A4', 97, 1)").run()
    db.prepare(
      "INSERT INTO printers (id, code, name, type, equipment_cost_c, monthly_cost_c) VALUES (1, 'C850', 'C850', 'laser', 2060000, 50000)",
    ).run()
    db.prepare(
      `INSERT INTO print_modes (id, name, printer_id, ink_type, pricing_mode, ink_price_c,
                                yield_sheets, ref_size, max_size)
       VALUES (1, 'C850 黑白', 1, 'toner', 'set', 140000, 56000, 'A4', 'A4')`,
    ).run()
    db.prepare("INSERT INTO papers (id, name, category) VALUES (1, '亚太森博 A4', 'plain')").run()
    db.prepare(
      "INSERT INTO paper_size_costs (paper_id, size_key, pack_price_c, pack_count) VALUES (1, 'A4', 39653, 12500)",
    ).run()
    db.prepare("INSERT INTO combos (id, mode_id, paper_id) VALUES (1, 1, 1)").run()
    db.prepare(
      "INSERT INTO combo_prices (combo_id, size_key, sell_c, internal_sell_c) VALUES (1, 'A4', 7, 5)",
    ).run()
    db.prepare(
      "INSERT INTO combo_price_tiers (combo_id, size_key, min_qty, sell_c, internal_sell_c) VALUES (1, 'A4', 100, 6, 4)",
    ).run()
    db.prepare(
      `INSERT INTO consumables (id, name, type, printer_id, quantity, cost_model, rated_life_pages, unit_cost_c)
       VALUES ('t01', 'T01', 'toner', 1, 1, 'per_page', 56000, 140000)`,
    ).run()
    db.prepare(
      "INSERT INTO finishing_ops (id, name, pricing, price_c, category) VALUES (99, '测试工艺', 'per_book', 200, 'binding')",
    ).run()

    db.pragma('user_version = 34')

    expect(migrate(db)).toBe(1)
    expect(db.pragma('user_version', { simple: true })).toBe(35)
    expect(
      db
        .prepare(
          `SELECT p.equipment_cost_c, p.monthly_cost_c, m.ink_price_c,
                  psc.pack_price_c, cp.sell_c, cp.internal_sell_c,
                  cpt.sell_c AS tier_sell_c, cpt.internal_sell_c AS tier_internal_sell_c,
                  c.unit_cost_c, f.price_c
           FROM printers p
           JOIN print_modes m ON m.printer_id = p.id
           JOIN paper_size_costs psc ON psc.paper_id = 1 AND psc.size_key = 'A4'
           JOIN combo_prices cp ON cp.combo_id = 1 AND cp.size_key = 'A4'
           JOIN combo_price_tiers cpt ON cpt.combo_id = 1 AND cpt.size_key = 'A4'
           JOIN consumables c ON c.printer_id = p.id
           JOIN finishing_ops f ON f.id = 99`,
        )
        .get(),
    ).toEqual({
      equipment_cost_c: 206000000,
      monthly_cost_c: 5000000,
      ink_price_c: 14000000,
      pack_price_c: 3965300,
      sell_c: 700,
      internal_sell_c: 500,
      tier_sell_c: 600,
      tier_internal_sell_c: 400,
      unit_cost_c: 14000000,
      price_c: 20000,
    })
  })

  it('外键每连接开启', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('currencies 种子随 schema 落库：JPY/CNY/USD 符号与小数位', () => {
    migrate(db)
    const rows = db
      .prepare('SELECT code, symbol, decimal_places FROM currencies ORDER BY code')
      .all() as Array<{ code: string; symbol: string; decimal_places: number }>
    expect(rows).toEqual([
      { code: 'CNY', symbol: '￥', decimal_places: 2 },
      { code: 'JPY', symbol: '¥', decimal_places: 0 },
      { code: 'USD', symbol: '$', decimal_places: 2 },
    ])
  })
})

describe('§7 STRICT / 类型边界（DB 层防呆）', () => {
  let db: DB
  beforeEach(() => {
    db = openDb(':memory:')
    migrate(db)
  })
  afterEach(() => {
    db.close()
  })

  it('绕过 API 直插 REAL 金额 → STRICT 拒绝', () => {
    const insert = db.prepare(
      "INSERT INTO printers (code, name, type, equipment_cost_c) VALUES ('X1', 'X', 'laser', ?)",
    )
    expect(() => insert.run(1.5)).toThrow(/cannot store REAL value in INTEGER column/i)
    expect(() => insert.run(2060000)).not.toThrow()
  })

  it("STRICT 对 TEXT 的边界：'100' 可无损转换被容许（拦截它是 API schema 的职责），'abc' 拒绝", () => {
    const insert = db.prepare(
      "INSERT INTO printers (code, name, type, equipment_cost_c) VALUES (?, 'X', 'laser', ?)",
    )
    expect(() => insert.run('X2', '100')).not.toThrow()
    expect(() => insert.run('X3', 'abc')).toThrow(/cannot store TEXT value in INTEGER column/i)
  })

  it('外键约束生效：print_modes 指向不存在的 printer → 拒绝', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO print_modes (name, printer_id, ink_type, pricing_mode, ink_price_c, yield_sheets, ref_size, max_size)
           VALUES ('ghost', 999, 'toner', 'set', 1, 1, 'A4', 'A4')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i)
  })

  it('CHECK 约束生效：未知 role → 拒绝', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (id, email, password_hash, name, role, created_at)
           VALUES ('u1', 'a@b.c', 'h', 'A', 'superadmin', '2026-06-10T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i)
  })
})

describe('uniq_alert_open（C8 去重在数据库层强制）', () => {
  let db: DB
  beforeEach(() => {
    db = openDb(':memory:')
    migrate(db)
  })
  afterEach(() => {
    db.close()
  })

  const insertAlert = (db: DB, id: string) =>
    db
      .prepare(
        `INSERT INTO alerts (id, type, severity, target_type, target_id, message, created_at)
         VALUES (?, 'consumable_low', 'warning', 'consumable', 'c1', 'low', '2026-06-10T00:00:00Z')`,
      )
      .run(id)

  it('未解决的同源同类提醒不可重复创建', () => {
    insertAlert(db, 'a1')
    expect(() => insertAlert(db, 'a2')).toThrow(/UNIQUE constraint failed/i)
  })

  it('resolve 后再次越界 → 新 Alert 创建成功', () => {
    insertAlert(db, 'a1')
    db.prepare("UPDATE alerts SET resolved_at = '2026-06-10T01:00:00Z' WHERE id = 'a1'").run()
    expect(() => insertAlert(db, 'a3')).not.toThrow()
  })
})
