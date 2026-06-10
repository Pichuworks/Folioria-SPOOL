import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  calibrationDue,
  checkCalibration,
  checkConsumableThreshold,
  raiseAlert,
  resolveAlert,
} from './alerts.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { makeTestDb, withSystemConfig } from './test-helpers.js'

let db: DB
beforeEach(() => {
  db = makeTestDb()
  withSystemConfig(db)
  importSeed(db)
})
afterEach(() => {
  db.close()
})

const openAlerts = () =>
  db.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL').all() as Array<{
    id: string
    type: string
    severity: string
  }>

describe('§4 提醒去重 / 升级 / resolve 重建', () => {
  const input = {
    type: 'consumable_low' as const,
    severity: 'warning' as const,
    target_type: 'consumable',
    target_id: 'c1',
    message: '20%',
  }

  it('首次 created；同源同类再触发 noop（不新建）', () => {
    expect(raiseAlert(db, input)).toBe('created')
    expect(raiseAlert(db, { ...input, message: '19%' })).toBe('noop')
    expect(openAlerts().length).toBe(1)
  })

  it('severity 原地升级', () => {
    raiseAlert(db, input)
    expect(raiseAlert(db, { ...input, severity: 'critical', message: '0%' })).toBe('upgraded')
    const alerts = openAlerts()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.severity).toBe('critical')
  })

  it('resolve 后再次越界 → 新 Alert 创建成功', () => {
    raiseAlert(db, input)
    const id = openAlerts()[0]?.id ?? ''
    expect(resolveAlert(db, id)).toBe(true)
    expect(raiseAlert(db, input)).toBe('created')
    expect(openAlerts().length).toBe(1)
  })
})

describe('§4 校准双触发（C6）', () => {
  const base = {
    id: 1,
    code: 'C850',
    total_pages: 0,
    last_calibration_at: null as string | null,
    last_calibration_pages: 0,
    calibration_interval_pages: null as number | null,
    calibration_interval_days: null as number | null,
  }
  const now = new Date('2026-06-10T00:00:00Z')

  it('两者均 NULL → 不触发', () => {
    expect(calibrationDue({ ...base, total_pages: 999999 }, now)).toBe(false)
  })

  it('页数超限触发', () => {
    expect(
      calibrationDue(
        { ...base, total_pages: 3000, calibration_interval_pages: 3000 },
        now,
      ),
    ).toBe(true)
    expect(
      calibrationDue(
        { ...base, total_pages: 2999, calibration_interval_pages: 3000 },
        now,
      ),
    ).toBe(false)
  })

  it('天数超限触发（未校准过则天数维度无基线不触发）', () => {
    expect(
      calibrationDue(
        { ...base, last_calibration_at: '2026-05-01T00:00:00Z', calibration_interval_days: 30 },
        now,
      ),
    ).toBe(true)
    expect(
      calibrationDue(
        { ...base, last_calibration_at: '2026-06-01T00:00:00Z', calibration_interval_days: 30 },
        now,
      ),
    ).toBe(false)
    expect(calibrationDue({ ...base, calibration_interval_days: 30 }, now)).toBe(false)
  })

  it('checkCalibration due → 产生 calibration_due 提醒且去重', () => {
    const printer = db.prepare("SELECT id FROM printers WHERE code = 'C850'").get() as { id: number }
    db.prepare('UPDATE printers SET total_pages = 5000, calibration_interval_pages = 3000 WHERE id = ?').run(printer.id)
    expect(checkCalibration(db, printer.id)).toBe(true)
    expect(checkCalibration(db, printer.id)).toBe(true)
    expect(openAlerts().filter((a) => a.type === 'calibration_due').length).toBe(1)
  })
})

describe('§4 耗材阈值（usage 越界 → Alert；再次越过不新建；resolve 后重建）', () => {
  it('完整闭环', () => {
    const c = db.prepare('SELECT id, rated_life_pages FROM consumables LIMIT 1').get() as {
      id: string
      rated_life_pages: number
    }
    // 阈值 2000bp = 20%；用到剩 19%
    db.prepare('UPDATE consumables SET current_usage_pages = ? WHERE id = ?').run(
      Math.ceil(c.rated_life_pages * 0.81),
      c.id,
    )
    expect(checkConsumableThreshold(db, c.id)).toBe(true)
    expect(openAlerts().length).toBe(1)

    // 19% → 18%：不新建（no-op）
    db.prepare('UPDATE consumables SET current_usage_pages = ? WHERE id = ?').run(
      Math.ceil(c.rated_life_pages * 0.82),
      c.id,
    )
    expect(checkConsumableThreshold(db, c.id)).toBe(true)
    expect(openAlerts().length).toBe(1)

    // 耗尽 → 原地升级 critical
    db.prepare('UPDATE consumables SET current_usage_pages = ? WHERE id = ?').run(
      c.rated_life_pages,
      c.id,
    )
    checkConsumableThreshold(db, c.id)
    expect(openAlerts()[0]?.severity).toBe('critical')

    // resolve 后再次越界 → 新 Alert
    const id = openAlerts()[0]?.id ?? ''
    resolveAlert(db, id)
    expect(checkConsumableThreshold(db, c.id)).toBe(true)
    expect(openAlerts().length).toBe(1)

    // 未越界不提醒
    db.prepare('UPDATE consumables SET current_usage_pages = 0 WHERE id = ?').run(c.id)
    resolveAlert(db, openAlerts()[0]?.id ?? '')
    expect(checkConsumableThreshold(db, c.id)).toBe(false)
    expect(openAlerts().length).toBe(0)
  })
})
