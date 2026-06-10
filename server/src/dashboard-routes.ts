import { type FastifyInstance } from 'fastify'
import { calibrationDue } from './alerts.js'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'

interface PrinterRow {
  id: number
  code: string
  name: string
  status: string
  total_pages: number
  last_calibration_at: string | null
  last_calibration_pages: number
  calibration_interval_pages: number | null
  calibration_interval_days: number | null
}

export function registerDashboardRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/dashboard', { preHandler: requireAdmin }, async () => {
    const month = new Date().toISOString().slice(0, 7)

    const jobsActive = (
      db
        .prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('draft', 'queued', 'printing')")
        .get() as { n: number }
    ).n
    const ordersActive = (
      db
        .prepare(
          "SELECT COUNT(*) n FROM orders WHERE status NOT IN ('delivered', 'cancelled')",
        )
        .get() as { n: number }
    ).n
    const maintenanceAlerts = (
      db
        .prepare(
          "SELECT COUNT(*) n FROM alerts WHERE resolved_at IS NULL AND type IN ('calibration_due', 'maintenance_due')",
        )
        .get() as { n: number }
    ).n

    const inventoryAlerts = db
      .prepare(
        `SELECT * FROM alerts
         WHERE resolved_at IS NULL AND type IN ('low_stock', 'consumable_low', 'moisture_warning')
         ORDER BY severity DESC, created_at DESC LIMIT 20`,
      )
      .all()

    const monthly = db
      .prepare(
        `SELECT COUNT(*) AS jobs_done,
                COALESCE(SUM(CASE WHEN quoted_price IS NOT NULL THEN quoted_price END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN quoted_price IS NOT NULL THEN total_cost END), 0) AS external_cost,
                COALESCE(SUM(CASE WHEN quoted_price IS NULL THEN total_cost END), 0) AS internal_cost,
                COALESCE(SUM(profit), 0) AS profit,
                COALESCE(SUM(pages_consumed), 0) AS pages
         FROM jobs WHERE status = 'done' AND substr(completed_at, 1, 7) = ?`,
      )
      .get(month)

    const now = new Date()
    const equipment = (
      db
        .prepare(
          `SELECT id, code, name, status, total_pages, last_calibration_at, last_calibration_pages,
                  calibration_interval_pages, calibration_interval_days
           FROM printers WHERE archived = 0 ORDER BY id`,
        )
        .all() as PrinterRow[]
    ).map((p) => ({
      code: p.code,
      name: p.name,
      status: p.status,
      total_pages: p.total_pages,
      calibration_due: calibrationDue(p, now),
    }))

    return {
      todo: {
        jobs_active: jobsActive,
        orders_active: ordersActive,
        maintenance_alerts: maintenanceAlerts,
      },
      inventory_alerts: inventoryAlerts,
      monthly,
      equipment,
    }
  })
}
