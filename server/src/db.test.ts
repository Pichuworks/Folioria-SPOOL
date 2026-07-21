import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, migrate, openDb, type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { withSystemConfig } from './test-helpers.js'

const SCHEMA_PATH = fileURLToPath(new URL('../../docs/schema.sql', import.meta.url))
const MIGRATION_0001_PATH = fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url))

describe('migration runner', () => {
  let db: DB
  const tempDirs: string[] = []

  function migrationDirThrough(maxVersion: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'spool-migrations-'))
    tempDirs.push(dir)
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      if (/^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= maxVersion) {
        copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name))
      }
    }
    return dir
  }

  beforeEach(() => {
    db = openDb(':memory:')
  })
  afterEach(() => {
    db.close()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('0001_init.sql 与 docs/schema.sql 字节级一致（分歧守卫——schema 变更必须走新 migration）', () => {
    const schema = readFileSync(SCHEMA_PATH)
    const migration = readFileSync(MIGRATION_0001_PATH)
    expect(migration.equals(schema)).toBe(true)
  })

  it('migrate 应用全部 migration 后 user_version=最新，重复执行幂等', () => {
    expect(migrate(db)).toBe(37)
    expect(db.pragma('user_version', { simple: true })).toBe(37)
    expect(migrate(db)).toBe(0)
    expect(db.pragma('user_version', { simple: true })).toBe(37)
  })

  it('0037：完整常用尺寸目录与开纸换算规则落库', () => {
    migrate(db)
    withSystemConfig(db)
    importSeed(db)
    const keys = (db.prepare('SELECT key FROM sizes ORDER BY key').all() as Array<{ key: string }>).map((s) => s.key)
    expect(keys).toEqual(expect.arrayContaining([
      'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
      'B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8',
      'RA0', 'RA1', 'RA2', 'RA3', 'RA4',
      'SRA0', 'SRA1', 'SRA2', 'SRA3', 'SRA4',
      '6', 'A3P', 'A3PP',
    ]))

    const yieldOf = (source: string, target: string) =>
      (db.prepare(
        'SELECT yield_count FROM size_conversions WHERE source_size_key = ? AND target_size_key = ?',
      ).get(source, target) as { yield_count: number } | undefined)?.yield_count
    expect(yieldOf('A4', 'A5')).toBe(2)
    expect(yieldOf('A3', 'A5')).toBe(4)
    expect(yieldOf('A3', 'B5')).toBe(2)
    expect(yieldOf('SRA3', '6')).toBe(8)
    expect(yieldOf('A3', '6')).toBe(6)
    const missingRules = db.prepare(
      `SELECT COUNT(*) AS n
       FROM sizes source CROSS JOIN sizes target
       WHERE source.key <> target.key
         AND source.width_mm IS NOT NULL AND source.height_mm IS NOT NULL
         AND target.width_mm IS NOT NULL AND target.height_mm IS NOT NULL
         AND MAX(
           CAST(source.width_mm / target.width_mm AS INTEGER) * CAST(source.height_mm / target.height_mm AS INTEGER),
           CAST(source.width_mm / target.height_mm AS INTEGER) * CAST(source.height_mm / target.width_mm AS INTEGER)
         ) > 0
         AND NOT EXISTS (
           SELECT 1 FROM size_conversions sc
           WHERE sc.source_size_key = source.key AND sc.target_size_key = target.key
         )`,
    ).get() as { n: number }
    expect(missingRules.n).toBe(0)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM size_conversions WHERE source_size_key IN ('A3P','A3PP')").get() as { n: number }).n,
    ).toBe(0)
  })

  it('0037：既有实例统一目录顺序，同时保留管理员已填的物理尺寸', () => {
    migrate(db, migrationDirThrough(36))
    db.prepare(
      "INSERT INTO sizes (key, label, area, sort, width_mm, height_mm) VALUES ('A5', '旧 A5', 49, 1, 150, 212)",
    ).run()

    expect(migrate(db)).toBe(1)
    expect(db.prepare("SELECT label, area, sort, width_mm, height_mm FROM sizes WHERE key = 'A5'").get()).toEqual({
      label: 'A5',
      area: 48,
      sort: 40,
      width_mm: 150,
      height_mm: 212,
    })
    expect((db.prepare('SELECT COUNT(*) AS n FROM sizes').get() as { n: number }).n).toBe(31)
  })

  it('0019：v18 JPY 实例升级时保留业务数据与基准货币', () => {
    expect(migrate(db, migrationDirThrough(18))).toBe(18)
    spoolInit(db, {
      baseCurrency: 'JPY',
      adminEmail: 'admin@example.com',
      adminName: 'Admin',
      adminPassword: 'strong-pass-1',
    })
    importSeed(db)
    const adminId = (db.prepare("SELECT id FROM users WHERE role = 'admin'").get() as { id: string }).id
    db.prepare(
      `INSERT INTO orders (id, order_number, access_token, customer_id, subtotal, total,
                           quote_valid_until, created_at)
       VALUES ('o1', 'FOL-2026-0001', 'token-1', ?, 100, 100,
               '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
    ).run(adminId)
    db.prepare(
      `INSERT INTO payments (id, order_id, kind, amount, operator_id, created_at)
       VALUES ('pay1', 'o1', 'deposit', 50, ?, '2026-07-01T01:00:00Z')`,
    ).run(adminId)
    db.prepare(
      `INSERT INTO admin_audit (id, actor_id, action, target_type, target_id, summary, created_at)
       VALUES ('audit1', ?, 'order.create', 'order', 'o1', 'created', '2026-07-01T00:00:00Z')`,
    ).run(adminId)
    db.prepare(
      `INSERT INTO report_snapshots
         (month, ext_revenue, ext_cost, ext_profit, int_cost, jobs_done, pages, payload, generated_at)
       VALUES ('2026-06', 100, 40, 60, 0, 1, 10, '{}', '2026-07-01T05:00:00Z')`,
    ).run()
    db.prepare(
      `INSERT INTO maintenance_events (id, printer_id, type, occurred_at, operator_id, cost)
       VALUES ('maint1', 1, 'calibration', '2026-07-01T00:00:00Z', ?, 20)`,
    ).run(adminId)

    const before = {
      orders: (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n,
      payments: (db.prepare('SELECT COUNT(*) AS n FROM payments').get() as { n: number }).n,
      audit: (db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n,
      snapshots: (db.prepare('SELECT COUNT(*) AS n FROM report_snapshots').get() as { n: number }).n,
      maintenance: (db.prepare('SELECT COUNT(*) AS n FROM maintenance_events').get() as { n: number }).n,
    }

    expect(migrate(db)).toBe(19)
    expect((db.prepare('SELECT base_currency FROM system_config WHERE id = 1').get() as { base_currency: string }).base_currency).toBe('JPY')
    expect({
      orders: (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n,
      payments: (db.prepare('SELECT COUNT(*) AS n FROM payments').get() as { n: number }).n,
      audit: (db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n,
      snapshots: (db.prepare('SELECT COUNT(*) AS n FROM report_snapshots').get() as { n: number }).n,
      maintenance: (db.prepare('SELECT COUNT(*) AS n FROM maintenance_events').get() as { n: number }).n,
    }).toEqual(before)
  })

  it('0035：v34 CNY 实例升级不改正确单价层，并置待复核标志', () => {
    expect(migrate(db, migrationDirThrough(34))).toBe(34)
    db.prepare(
      "INSERT INTO system_config (id, base_currency, initialized_at) VALUES (1, 'CNY', '2026-07-09T00:00:00Z')",
    ).run()
    db.prepare("INSERT INTO sizes (key, label, area, sort) VALUES ('A4', 'A4', 97, 1)").run()
    db.prepare(
      "INSERT INTO printers (id, code, name, type, equipment_cost_c, monthly_cost_c) VALUES (1, 'C850', 'C850', 'laser', 206000000, 5000000)",
    ).run()
    db.prepare(
      `INSERT INTO print_modes (id, name, printer_id, ink_type, pricing_mode, ink_price_c,
                                yield_sheets, ref_size, max_size)
       VALUES (1, 'C850 黑白', 1, 'toner', 'set', 14000000, 56000, 'A4', 'A4')`,
    ).run()
    db.prepare("INSERT INTO papers (id, name, category) VALUES (1, '亚太森博 A4', 'plain')").run()
    db.prepare(
      "INSERT INTO paper_size_costs (paper_id, size_key, pack_price_c, pack_count) VALUES (1, 'A4', 3965300, 12500)",
    ).run()
    db.prepare("INSERT INTO combos (id, mode_id, paper_id) VALUES (1, 1, 1)").run()
    db.prepare(
      "INSERT INTO combo_prices (combo_id, size_key, sell_c, internal_sell_c) VALUES (1, 'A4', 700, 500)",
    ).run()
    db.prepare(
      "INSERT INTO combo_price_tiers (combo_id, size_key, min_qty, sell_c, internal_sell_c) VALUES (1, 'A4', 100, 600, 400)",
    ).run()
    db.prepare(
      `INSERT INTO consumables (id, name, type, printer_id, quantity, cost_model, rated_life_pages, unit_cost_c)
       VALUES ('t01', 'T01', 'toner', 1, 1, 'per_page', 56000, 14000000)`,
    ).run()
    db.prepare(
      "INSERT INTO finishing_ops (id, name, pricing, price_c, category) VALUES (99, '测试工艺', 'per_book', 20000, 'binding')",
    ).run()

    expect(migrate(db)).toBe(3)
    expect(db.pragma('user_version', { simple: true })).toBe(37)
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
    expect(
      (db.prepare('SELECT pricing_needs_reentry FROM system_config WHERE id = 1').get() as { pricing_needs_reentry: number })
        .pricing_needs_reentry,
    ).toBe(1)
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
