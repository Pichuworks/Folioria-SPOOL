import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyBackup } from './backup.js'
import { migrate, openDb, type DB } from './db.js'
import {
  inspectPriceLayerScale,
  markPriceLayerScaleCanonical,
  repairCnyPriceLayer,
  repairCnyPriceLayerFile,
} from './pricing-scale.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

interface PriceFacts {
  equipment_cost_c: number
  monthly_cost_c: number
  ink_price_c: number
  pack_price_c: number
  sell_c: number
  internal_sell_c: number | null
  tier_sell_c: number
  tier_internal_sell_c: number | null
  unit_cost_c: number
  finishing_price_c: number
}

function configureReviewFixture(db: DB): void {
  importSeed(db)
  db.prepare("UPDATE combo_prices SET internal_sell_c = 500 WHERE combo_id = 1 AND size_key = 'A4'").run()
  db.prepare(
    "INSERT INTO combo_price_tiers (combo_id, size_key, min_qty, sell_c, internal_sell_c) VALUES (1, 'A4', 100, 600, NULL)",
  ).run()
  db.prepare(
    "INSERT INTO finishing_ops (id, name, pricing, price_c, category) VALUES (99, '装订', 'per_book', 20000, 'binding')",
  ).run()
  db.prepare('UPDATE system_config SET pricing_needs_reentry = 1 WHERE id = 1').run()
}

function readPriceFacts(db: DB): PriceFacts {
  return db
    .prepare(
      `SELECT p.equipment_cost_c, p.monthly_cost_c, m.ink_price_c,
              psc.pack_price_c, cp.sell_c, cp.internal_sell_c,
              cpt.sell_c AS tier_sell_c, cpt.internal_sell_c AS tier_internal_sell_c,
              c.unit_cost_c, f.price_c AS finishing_price_c
       FROM printers p
       JOIN print_modes m ON m.printer_id = p.id AND m.id = 1
       JOIN paper_size_costs psc ON psc.paper_id = 1 AND psc.size_key = 'A4'
       JOIN combo_prices cp ON cp.combo_id = 1 AND cp.size_key = 'A4'
       JOIN combo_price_tiers cpt ON cpt.combo_id = 1 AND cpt.size_key = 'A4' AND cpt.min_qty = 100
       JOIN consumables c ON c.printer_id = p.id
       JOIN finishing_ops f ON f.id = 99
       WHERE p.id = 1`,
    )
    .get() as PriceFacts
}

describe('CNY price-layer scale review', () => {
  let db: DB

  beforeEach(() => {
    db = makeTestDb()
    withSystemConfig(db, 'CNY')
    configureReviewFixture(db)
  })

  afterEach(() => db.close())

  it('inspection reports all approved fields and the pending review guard', () => {
    const inspection = inspectPriceLayerScale(db)
    expect(inspection.currency).toBe('CNY')
    expect(inspection.needs_review).toBe(true)
    expect(inspection.fields).toHaveLength(10)
    expect(inspection.fields.map((f) => `${f.table}.${f.column}`)).toEqual([
      'printers.equipment_cost_c',
      'printers.monthly_cost_c',
      'print_modes.ink_price_c',
      'paper_size_costs.pack_price_c',
      'combo_prices.sell_c',
      'combo_prices.internal_sell_c',
      'combo_price_tiers.sell_c',
      'combo_price_tiers.internal_sell_c',
      'consumables.unit_cost_c',
      'finishing_ops.price_c',
    ])
    expect(inspection.fields.every((f) => Number.isSafeInteger(f.rows) && f.rows >= 0)).toBe(true)
    expect(inspection.fields.every((f) => Array.isArray(f.samples) && f.samples.length <= 3)).toBe(true)
  })

  it('mark-canonical clears only the guard, audits the decision, and cannot repeat', () => {
    const before = readPriceFacts(db)

    markPriceLayerScaleCanonical(db)

    expect(readPriceFacts(db)).toEqual(before)
    expect(inspectPriceLayerScale(db).needs_review).toBe(false)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'pricing.scale.mark_canonical'").get() as { n: number }).n,
    ).toBe(1)
    expect(() => markPriceLayerScaleCanonical(db)).toThrow(/already_resolved/)
  })

  it('repair multiplies only approved price facts once and preserves amount snapshots', () => {
    const adminId = createTestUser(db, { email: 'admin@example.com', role: 'admin' })
    db.prepare(
      `INSERT INTO orders (id, order_number, access_token, customer_id, subtotal, total,
                           quote_valid_until, created_at)
       VALUES ('o1', 'FOL-2026-0001', 'token-1', ?, 12345, 12345,
               '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
    ).run(adminId)
    const before = readPriceFacts(db)

    const result = repairCnyPriceLayer(db)

    const after = readPriceFacts(db)
    for (const key of Object.keys(before) as Array<keyof PriceFacts>) {
      const oldValue = before[key]
      expect(after[key]).toBe(oldValue == null ? null : oldValue * 100)
    }
    expect(result.updated.printers).toBeGreaterThan(0)
    expect((db.prepare("SELECT total FROM orders WHERE id = 'o1'").get() as { total: number }).total).toBe(12345)
    expect(inspectPriceLayerScale(db).needs_review).toBe(false)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'pricing.scale.repair_cny'").get() as { n: number }).n,
    ).toBe(1)
    expect(() => repairCnyPriceLayer(db)).toThrow(/already_resolved/)
  })

  it('overflow aborts atomically without clearing the guard or changing any field', () => {
    const tooLarge = Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1
    db.prepare('UPDATE printers SET equipment_cost_c = ? WHERE id = 1').run(tooLarge)
    const before = readPriceFacts(db)

    expect(() => repairCnyPriceLayer(db)).toThrow(/overflow/)

    expect(readPriceFacts(db)).toEqual(before)
    expect(inspectPriceLayerScale(db).needs_review).toBe(true)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'pricing.scale.repair_cny'").get() as { n: number }).n,
    ).toBe(0)
  })

  it('non-CNY instances cannot be marked or repaired', () => {
    db.close()
    db = makeTestDb()
    withSystemConfig(db, 'JPY')
    db.prepare('UPDATE system_config SET pricing_needs_reentry = 1 WHERE id = 1').run()

    expect(() => markPriceLayerScaleCanonical(db)).toThrow(/currency_not_cny/)
    expect(() => repairCnyPriceLayer(db)).toThrow(/currency_not_cny/)
  })

  it('file repair requires confirmation and creates a verified backup before mutation', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-scale-file-'))
    const dbPath = path.join(root, 'folioria.db')
    const backupDir = path.join(root, 'backups')
    const fileDb = openDb(dbPath)
    try {
      migrate(fileDb)
      withSystemConfig(fileDb, 'CNY')
      configureReviewFixture(fileDb)
    } finally {
      fileDb.close()
    }

    try {
      expect(() => repairCnyPriceLayerFile(dbPath, backupDir, { confirm: false })).toThrow(/confirmation_required/)
      expect(existsSync(backupDir)).toBe(false)

      const result = repairCnyPriceLayerFile(dbPath, backupDir, { confirm: true })

      expect(verifyBackup(result.backup).ok).toBe(true)
      expect(result.before.needs_review).toBe(true)
      expect(result.after.needs_review).toBe(false)
      const reopened = openDb(dbPath)
      try {
        expect(inspectPriceLayerScale(reopened).needs_review).toBe(false)
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
