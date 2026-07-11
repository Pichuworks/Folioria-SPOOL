import { randomUUID } from 'node:crypto'
import { backupDb, verifyBackup } from './backup.js'
import { migrate, openDb, type DB } from './db.js'

const SCALE_FIELDS = [
  ['printers', 'equipment_cost_c'],
  ['printers', 'monthly_cost_c'],
  ['print_modes', 'ink_price_c'],
  ['paper_size_costs', 'pack_price_c'],
  ['combo_prices', 'sell_c'],
  ['combo_prices', 'internal_sell_c'],
  ['combo_price_tiers', 'sell_c'],
  ['combo_price_tiers', 'internal_sell_c'],
  ['consumables', 'unit_cost_c'],
  ['finishing_ops', 'price_c'],
] as const

export interface PriceLayerScaleField {
  table: string
  column: string
  rows: number
  max: number | null
  samples: number[]
}

export interface PriceLayerScaleInspection {
  currency: string
  needs_review: boolean
  fields: PriceLayerScaleField[]
}

export interface PriceLayerScaleRepairResult {
  before: PriceLayerScaleInspection
  after: PriceLayerScaleInspection
  updated: Record<string, number>
}

export interface PriceLayerScaleFileRepairResult extends PriceLayerScaleRepairResult {
  backup: string
}

interface ScaleConfig {
  base_currency: string
  pricing_needs_reentry: number
}

function config(db: DB): ScaleConfig {
  const row = db
    .prepare('SELECT base_currency, pricing_needs_reentry FROM system_config WHERE id = 1')
    .get() as ScaleConfig | undefined
  if (!row) throw new Error('pricing scale: instance_not_initialized')
  return row
}

export function inspectPriceLayerScale(db: DB): PriceLayerScaleInspection {
  const cfg = config(db)
  const fields = SCALE_FIELDS.map(([table, column]) => {
    const row = db
      .prepare(`SELECT COUNT(${column}) AS rows, MAX(${column}) AS max FROM ${table}`)
      .get() as { rows: number; max: number | null }
    const samples = db
      .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${column} LIMIT 3`)
      .all()
      .map((sample) => (sample as { value: number }).value)
    return { table, column, rows: row.rows, max: row.max, samples }
  })
  return {
    currency: cfg.base_currency,
    needs_review: cfg.pricing_needs_reentry !== 0,
    fields,
  }
}

function assertReviewable(db: DB): void {
  const cfg = config(db)
  if (cfg.base_currency !== 'CNY') throw new Error('pricing scale: currency_not_cny')
  if (cfg.pricing_needs_reentry === 0) throw new Error('pricing scale: already_resolved')
}

function insertAudit(db: DB, action: string, summary: string, detail: unknown): void {
  db.prepare(
    `INSERT INTO admin_audit (id, actor_id, action, target_type, target_id, summary, detail, created_at)
     VALUES (?, NULL, ?, 'system_config', '1', ?, ?, ?)`,
  ).run(randomUUID(), action, summary, JSON.stringify(detail), new Date().toISOString())
}

export function markPriceLayerScaleCanonical(db: DB): PriceLayerScaleInspection {
  assertReviewable(db)
  const before = inspectPriceLayerScale(db)
  db.transaction(() => {
    db.prepare('UPDATE system_config SET pricing_needs_reentry = 0 WHERE id = 1').run()
    insertAudit(
      db,
      'pricing.scale.mark_canonical',
      'CNY 单价层经人工检查，确认已是最小货币单位 x100',
      { before },
    )
  })()
  return inspectPriceLayerScale(db)
}

export function repairCnyPriceLayer(db: DB): PriceLayerScaleRepairResult {
  assertReviewable(db)
  const before = inspectPriceLayerScale(db)
  const maxBeforeScale = Math.floor(Number.MAX_SAFE_INTEGER / 100)
  for (const field of before.fields) {
    if (field.max != null && (!Number.isSafeInteger(field.max) || field.max > maxBeforeScale)) {
      throw new RangeError(`pricing scale: overflow at ${field.table}.${field.column}`)
    }
  }

  const updated: Record<string, number> = {}
  db.transaction(() => {
    for (const [table, column] of SCALE_FIELDS) {
      const changes = db
        .prepare(`UPDATE ${table} SET ${column} = ${column} * 100 WHERE ${column} IS NOT NULL`)
        .run().changes
      updated[table] = (updated[table] ?? 0) + changes
    }
    db.prepare('UPDATE system_config SET pricing_needs_reentry = 0 WHERE id = 1').run()
    insertAudit(
      db,
      'pricing.scale.repair_cny',
      'CNY 单价层经确认从旧口径乘 100 修复为最小货币单位 x100',
      { fields: before.fields, updated },
    )
  })()

  return { before, after: inspectPriceLayerScale(db), updated }
}

export function repairCnyPriceLayerFile(
  dbPath: string,
  backupDir: string,
  opts: { confirm: boolean },
): PriceLayerScaleFileRepairResult {
  if (!opts.confirm) throw new Error('pricing scale: confirmation_required')

  const backup = backupDb(dbPath, backupDir, { keep: 30 })
  const report = verifyBackup(backup)
  if (!report.ok) {
    throw new Error(`pricing scale: backup_verification_failed: ${report.error ?? report.integrity}`)
  }

  const db = openDb(dbPath)
  try {
    migrate(db)
    return { backup, ...repairCnyPriceLayer(db) }
  } finally {
    db.close()
  }
}
