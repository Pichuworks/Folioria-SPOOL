import { type FastifyInstance } from 'fastify'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'
import { formatMoney, money } from './money.js'

const MONTH_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
}

const monthOf = (q: unknown): string =>
  (q as { month?: string }).month ?? new Date().toISOString().slice(0, 7)

export function registerReportsRoutes(app: FastifyInstance, db: DB): void {
  // 月度成本/收入，内部消耗单列（PRD §8：内部 = quoted_price IS NULL）
  app.get(
    '/api/reports/monthly',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req) => {
      const month = monthOf(req.query)
      const m = db
        .prepare(
          `SELECT COUNT(*) AS jobs_done,
                  COALESCE(SUM(pages_consumed), 0) AS pages,
                  COALESCE(SUM(CASE WHEN quoted_price IS NOT NULL THEN 1 ELSE 0 END), 0) AS ext_jobs,
                  COALESCE(SUM(CASE WHEN quoted_price IS NOT NULL THEN quoted_price END), 0) AS ext_revenue,
                  COALESCE(SUM(CASE WHEN quoted_price IS NOT NULL THEN total_cost END), 0) AS ext_cost,
                  COALESCE(SUM(CASE WHEN quoted_price IS NOT NULL THEN profit END), 0) AS ext_profit,
                  COALESCE(SUM(CASE WHEN quoted_price IS NULL THEN 1 ELSE 0 END), 0) AS int_jobs,
                  COALESCE(SUM(CASE WHEN quoted_price IS NULL THEN total_cost END), 0) AS int_cost,
                  COALESCE(SUM(CASE WHEN quoted_price IS NULL THEN pages_consumed END), 0) AS int_pages
           FROM jobs WHERE status = 'done' AND substr(completed_at, 1, 7) = ?`,
        )
        .get(month) as {
        jobs_done: number
        pages: number
        ext_jobs: number
        ext_revenue: number
        ext_cost: number
        ext_profit: number
        int_jobs: number
        int_cost: number
        int_pages: number
      }
      const currency = baseCurrency(db)
      return {
        month,
        jobs_done: m.jobs_done,
        pages: m.pages,
        external: {
          jobs: m.ext_jobs,
          revenue: m.ext_revenue,
          cost: m.ext_cost,
          profit: m.ext_profit,
          revenue_display: formatMoney(money(m.ext_revenue), currency),
          cost_display: formatMoney(money(m.ext_cost), currency),
          profit_display: formatMoney(money(m.ext_profit), currency),
        },
        internal: {
          jobs: m.int_jobs,
          cost: m.int_cost,
          pages: m.int_pages,
          cost_display: formatMoney(money(m.int_cost), currency),
        },
      }
    },
  )

  // 设备利用率：done 作业经 mode→printer 归集本月页数/作业数
  app.get(
    '/api/reports/equipment-usage',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req) => {
      const month = monthOf(req.query)
      const printers = db
        .prepare(
          `SELECT p.id, p.code, p.name, p.status, p.total_pages,
                  COALESCE(SUM(j.pages_consumed), 0) AS month_pages,
                  COUNT(j.id) AS month_jobs
           FROM printers p
           LEFT JOIN print_modes pm ON pm.printer_id = p.id
           LEFT JOIN jobs j ON j.mode_id = pm.id AND j.status = 'done'
                            AND substr(j.completed_at, 1, 7) = ?
           WHERE p.archived = 0
           GROUP BY p.id ORDER BY p.id`,
        )
        .all(month)
      return { month, printers }
    },
  )

  // 纸张消耗排行：inventory_log consume/scrap 出库（张），purchase/adjust/convert 不计
  app.get(
    '/api/reports/paper-consumption',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req) => {
      const month = monthOf(req.query)
      const rows = db
        .prepare(
          `SELECT ps.paper_id, pa.name, ps.size_key,
                  COALESCE(SUM(CASE WHEN il.action = 'consume' THEN -il.quantity_delta END), 0) AS consumed,
                  COALESCE(SUM(CASE WHEN il.action = 'scrap' THEN -il.quantity_delta END), 0) AS scrapped,
                  COALESCE(SUM(-il.quantity_delta), 0) AS total
           FROM inventory_log il
           JOIN paper_stocks ps ON ps.id = il.target_id
           JOIN papers pa ON pa.id = ps.paper_id
           WHERE il.target_type = 'paper_stock' AND il.action IN ('consume', 'scrap')
             AND substr(il.created_at, 1, 7) = ?
           GROUP BY ps.paper_id, ps.size_key
           ORDER BY total DESC`,
        )
        .all(month)
      return { month, rows }
    },
  )
}
