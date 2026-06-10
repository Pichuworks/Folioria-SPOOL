import { randomUUID } from 'node:crypto'
import { type DB } from './db.js'

export type AlertSeverity = 'info' | 'warning' | 'critical'
const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 }

export interface RaiseAlertInput {
  type:
    | 'low_stock'
    | 'calibration_due'
    | 'maintenance_due'
    | 'order_due'
    | 'moisture_warning'
    | 'consumable_low'
  severity: AlertSeverity
  target_type: string
  target_id: string
  message: string
}

/**
 * C8 去重：未解决的同源同类提醒不可重复创建（uniq_alert_open 兜底），
 * 重复触发为 no-op；severity 升级时原地更新。
 */
export function raiseAlert(db: DB, input: RaiseAlertInput): 'created' | 'upgraded' | 'noop' {
  const open = db
    .prepare(
      `SELECT id, severity FROM alerts
       WHERE target_type = ? AND target_id = ? AND type = ? AND resolved_at IS NULL`,
    )
    .get(input.target_type, input.target_id, input.type) as
    | { id: string; severity: AlertSeverity }
    | undefined
  if (open) {
    if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[open.severity]) {
      db.prepare('UPDATE alerts SET severity = ?, message = ? WHERE id = ?').run(
        input.severity,
        input.message,
        open.id,
      )
      return 'upgraded'
    }
    return 'noop'
  }
  try {
    db.prepare(
      `INSERT INTO alerts (id, type, severity, target_type, target_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.type,
      input.severity,
      input.target_type,
      input.target_id,
      input.message,
      new Date().toISOString(),
    )
  } catch (err) {
    // 并发兜底：数据库层 uniq_alert_open 拒绝 → no-op
    if (err instanceof Error && err.message.includes('UNIQUE')) return 'noop'
    throw err
  }
  return 'created'
}

export function resolveAlert(db: DB, alertId: string): boolean {
  const { changes } = db
    .prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
    .run(new Date().toISOString(), alertId)
  return changes > 0
}

interface PrinterCalibrationRow {
  id: number
  code: string
  total_pages: number
  last_calibration_at: string | null
  last_calibration_pages: number
  calibration_interval_pages: number | null
  calibration_interval_days: number | null
}

/** C6 双触发：页数或天数任一超限即 due；对应维度为 NULL 则不触发 */
export function calibrationDue(p: PrinterCalibrationRow, now: Date): boolean {
  if (p.calibration_interval_pages != null) {
    if (p.total_pages - p.last_calibration_pages >= p.calibration_interval_pages) return true
  }
  if (p.calibration_interval_days != null && p.last_calibration_at != null) {
    const elapsedDays = (now.getTime() - Date.parse(p.last_calibration_at)) / 86_400_000
    if (elapsedDays >= p.calibration_interval_days) return true
  }
  return false
}

/** 校准检查：due 则产生（或维持）calibration_due 提醒 */
export function checkCalibration(db: DB, printerId: number, now = new Date()): boolean {
  const p = db
    .prepare(
      `SELECT id, code, total_pages, last_calibration_at, last_calibration_pages,
              calibration_interval_pages, calibration_interval_days
       FROM printers WHERE id = ? AND archived = 0`,
    )
    .get(printerId) as PrinterCalibrationRow | undefined
  if (!p || !calibrationDue(p, now)) return false
  raiseAlert(db, {
    type: 'calibration_due',
    severity: 'warning',
    target_type: 'printer',
    target_id: String(p.id),
    message: `${p.code} 校准到期（页数 ${p.total_pages - p.last_calibration_pages} / 上次 ${p.last_calibration_at ?? '未记录'}）`,
  })
  return true
}

/** 耗材阈值检查（C8）：remaining ≤ alert_threshold_bp 时提醒；耗尽升级 critical */
export function checkConsumableThreshold(db: DB, consumableId: string): boolean {
  const c = db
    .prepare(
      `SELECT id, name, cost_model, rated_life_pages, current_usage_pages, alert_threshold_bp
       FROM consumables WHERE id = ? AND archived = 0`,
    )
    .get(consumableId) as
    | {
        id: string
        name: string
        cost_model: string
        rated_life_pages: number | null
        current_usage_pages: number
        alert_threshold_bp: number
      }
    | undefined
  if (!c || c.cost_model !== 'per_page' || c.rated_life_pages == null || c.rated_life_pages <= 0) {
    return false
  }
  const left = c.rated_life_pages - c.current_usage_pages
  const num = Math.max(0, left) * 10000
  const remainingBp = (num - (num % c.rated_life_pages)) / c.rated_life_pages
  if (remainingBp > c.alert_threshold_bp) return false
  raiseAlert(db, {
    type: 'consumable_low',
    severity: remainingBp === 0 ? 'critical' : 'warning',
    target_type: 'consumable',
    target_id: c.id,
    message: `${c.name} 剩余 ${(remainingBp / 100).toFixed(2)}%（阈值 ${(c.alert_threshold_bp / 100).toFixed(2)}%）`,
  })
  return true
}
