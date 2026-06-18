import { type FastifyInstance } from 'fastify'
import { calibrationDue } from './alerts.js'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'
import { formatMoney, money } from './money.js'

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

// ---------- response schema（契约硬化）：镜像 handler 实际返回。inventory_alerts 为 alerts 全列；
// monthly 金额经 COALESCE 收敛为整数。管理域 cost/profit 对 admin 可见合规（acceptance §6 仅约束下单域）。
const DASHBOARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    todo: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobs_active: { type: 'integer' },
        orders_active: { type: 'integer' },
        maintenance_alerts: { type: 'integer' },
      },
    },
    inventory_alerts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          severity: { type: 'string' },
          target_type: { type: 'string' },
          target_id: { type: 'string' },
          message: { type: 'string' },
          acknowledged: { type: 'integer' },
          acknowledged_by: { type: ['string', 'null'] },
          created_at: { type: 'string' },
          resolved_at: { type: ['string', 'null'] },
        },
      },
    },
    monthly: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobs_done: { type: 'integer' },
        revenue: { type: 'integer' },
        external_cost: { type: 'integer' },
        internal_cost: { type: 'integer' },
        profit: { type: 'integer' },
        pages: { type: 'integer' },
        revenue_display: { type: 'string' },
        external_cost_display: { type: 'string' },
        internal_cost_display: { type: 'string' },
        profit_display: { type: 'string' },
      },
    },
    equipment: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          total_pages: { type: 'integer' },
          calibration_due: { type: 'boolean' },
        },
      },
    },
  },
}

export function registerDashboardRoutes(app: FastifyInstance, db: DB): void {
  app.get(
    '/api/dashboard',
    { preHandler: requireAdmin, schema: { response: { 200: DASHBOARD_SCHEMA } } },
    async () => {
    const now = new Date()
    // review M4：两端点一律 UTC。右端点曾用本地时区构造（new Date(y, m+1, 1)），
    // 在 UTC+N 服务器上比真正的下月 UTC 月初早 N 小时，漏算本月最后 N 小时完成的作业。
    const monthStart = now.toISOString().slice(0, 7) + '-01T00:00:00Z'
    const nextMonth =
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 19) + 'Z'

    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM jobs WHERE status IN ('draft', 'queued', 'printing')) AS jobs_active,
           (SELECT COUNT(*) FROM orders WHERE status NOT IN ('delivered', 'cancelled')) AS orders_active,
           (SELECT COUNT(*) FROM alerts WHERE resolved_at IS NULL AND type IN ('calibration_due', 'maintenance_due')) AS maintenance_alerts`,
      )
      .get() as { jobs_active: number; orders_active: number; maintenance_alerts: number }

    const inventoryAlerts = db
      .prepare(
        `SELECT * FROM alerts
         WHERE resolved_at IS NULL AND type IN ('low_stock', 'consumable_low', 'moisture_warning')
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                  created_at DESC LIMIT 20`,
      )
      .all()

    const m = db
      .prepare(
        `SELECT COUNT(*) AS jobs_done,
                COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN j.quoted_price END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN j.total_cost END), 0) AS external_cost,
                COALESCE(SUM(CASE WHEN j.quoted_price IS NULL THEN j.total_cost END), 0) AS internal_cost,
                COALESCE(SUM(CASE WHEN COALESCE(o.status,'') != 'cancelled' THEN j.profit END), 0) AS profit,
                COALESCE(SUM(j.pages_consumed), 0) AS pages
         FROM jobs j
         LEFT JOIN order_items oi ON oi.id = j.order_item_id
         LEFT JOIN orders o ON o.id = oi.order_id
         WHERE j.status = 'done' AND j.completed_at >= ? AND j.completed_at < ?`,
      )
      .get(monthStart, nextMonth) as {
      jobs_done: number
      revenue: number
      external_cost: number
      internal_cost: number
      profit: number
      pages: number
    }
    const currency = baseCurrency(db)
    const monthly = {
      ...m,
      revenue_display: formatMoney(money(m.revenue), currency),
      external_cost_display: formatMoney(money(m.external_cost), currency),
      internal_cost_display: formatMoney(money(m.internal_cost), currency),
      profit_display: formatMoney(money(m.profit), currency),
    }

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
      todo: counts,
      inventory_alerts: inventoryAlerts,
      monthly,
      equipment,
    }
  })
}
