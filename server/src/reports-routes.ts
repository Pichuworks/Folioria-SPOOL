import { type FastifyInstance, type FastifyReply } from 'fastify'
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

// ---------- 数据层（JSON 路由与 CSV 导出共用，避免 SQL 重复） ----------

interface MonthlyRow {
  jobs_done: number
  pages: number
  ext_jobs: number
  ext_revenue: number
  ext_cost: number
  ext_profit: number
  int_jobs: number
  int_cost: number
  int_pages: number
  writeoff_jobs: number
  writeoff_cost: number
}

export function monthlyReport(db: DB, month: string) {
  const m = db
    .prepare(
      `SELECT COUNT(*) AS jobs_done,
              COALESCE(SUM(j.pages_consumed), 0) AS pages,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN 1 ELSE 0 END), 0) AS ext_jobs,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN j.quoted_price END), 0) AS ext_revenue,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN j.total_cost END), 0) AS ext_cost,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN j.profit END), 0) AS ext_profit,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NULL THEN 1 ELSE 0 END), 0) AS int_jobs,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NULL THEN j.total_cost END), 0) AS int_cost,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NULL THEN j.pages_consumed END), 0) AS int_pages,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND o.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS writeoff_jobs,
              COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND o.status = 'cancelled' THEN j.total_cost END), 0) AS writeoff_cost
       FROM jobs j
       LEFT JOIN order_items oi ON oi.id = j.order_item_id
       LEFT JOIN orders o ON o.id = oi.order_id
       WHERE j.status = 'done' AND substr(j.completed_at, 1, 7) = ?`,
    )
    .get(month) as MonthlyRow
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
    writeoff: {
      jobs: m.writeoff_jobs,
      cost: m.writeoff_cost,
      cost_display: formatMoney(money(m.writeoff_cost), currency),
    },
  }
}

interface PrinterUsageRow {
  id: number
  code: string
  name: string
  status: string
  total_pages: number
  month_pages: number
  month_jobs: number
}

export function equipmentUsage(db: DB, month: string): { month: string; printers: PrinterUsageRow[] } {
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
    .all(month) as PrinterUsageRow[]
  return { month, printers }
}

interface PaperConsumptionRow {
  paper_id: number
  name: string
  size_key: string
  consumed: number
  scrapped: number
  total: number
}

export function paperConsumption(db: DB, month: string): { month: string; rows: PaperConsumptionRow[] } {
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
    .all(month) as PaperConsumptionRow[]
  return { month, rows }
}

// ---------- D34 月度快照（CLI/timer 月初归档上月；按 month 幂等 upsert） ----------

export interface SnapshotRow {
  month: string
  ext_revenue: number
  ext_cost: number
  ext_profit: number
  int_cost: number
  jobs_done: number
  pages: number
  generated_at: string
}

/** 计算 month 月度报表并幂等写入 report_snapshots（重算覆盖同月）。generatedAt 由调用方传入（CLI/测试可控） */
export function snapshotMonth(db: DB, month: string, generatedAt: string): SnapshotRow {
  const r = monthlyReport(db, month)
  const row = {
    month,
    ext_revenue: r.external.revenue,
    ext_cost: r.external.cost,
    ext_profit: r.external.profit,
    int_cost: r.internal.cost,
    jobs_done: r.jobs_done,
    pages: r.pages,
    payload: JSON.stringify(r),
    generated_at: generatedAt,
  }
  db.prepare(
    `INSERT INTO report_snapshots (month, ext_revenue, ext_cost, ext_profit, int_cost, jobs_done, pages, payload, generated_at)
     VALUES (@month, @ext_revenue, @ext_cost, @ext_profit, @int_cost, @jobs_done, @pages, @payload, @generated_at)
     ON CONFLICT(month) DO UPDATE SET
       ext_revenue = excluded.ext_revenue, ext_cost = excluded.ext_cost, ext_profit = excluded.ext_profit,
       int_cost = excluded.int_cost, jobs_done = excluded.jobs_done, pages = excluded.pages,
       payload = excluded.payload, generated_at = excluded.generated_at`,
  ).run(row)
  const { payload: _payload, ...rest } = row
  return rest
}

export function listSnapshots(db: DB, limit = 36): SnapshotRow[] {
  return db
    .prepare(
      `SELECT month, ext_revenue, ext_cost, ext_profit, int_cost, jobs_done, pages, generated_at
       FROM report_snapshots ORDER BY month DESC LIMIT ?`,
    )
    .all(limit) as SnapshotRow[]
}

// ---------- CSV 导出（金额输出基准货币最小单位整数，不经 formatMoney 除法） ----------

const csvCell = (v: string | number): string => {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** UTF-8 BOM（Excel 中文）+ CRLF 行尾 */
export function toCsv(rows: Array<Array<string | number>>): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

function sendCsv(reply: FastifyReply, filename: string, csv: string) {
  void reply.header('content-type', 'text/csv; charset=utf-8')
  void reply.header('content-disposition', `attachment; filename="${filename}"`)
  return reply.send(csv)
}

export function registerReportsRoutes(app: FastifyInstance, db: DB): void {
  // 月度成本/收入，内部消耗单列（PRD §8：内部 = quoted_price IS NULL）
  app.get(
    '/api/reports/monthly',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req) => monthlyReport(db, monthOf(req.query)),
  )

  // 设备利用率：done 作业经 mode→printer 归集本月页数/作业数
  app.get(
    '/api/reports/equipment-usage',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req) => equipmentUsage(db, monthOf(req.query)),
  )

  // 纸张消耗排行：inventory_log consume/scrap 出库（张），purchase/adjust/convert 不计
  app.get(
    '/api/reports/paper-consumption',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req) => paperConsumption(db, monthOf(req.query)),
  )

  // ---------- CSV 导出（同口径，admin） ----------

  app.get(
    '/api/reports/monthly/export',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req, reply) => {
      const month = monthOf(req.query)
      const r = monthlyReport(db, month)
      const cur = baseCurrency(db).code
      const csv = toCsv([
        ['分类', '作业数', `营收(${cur})`, `成本(${cur})`, `毛利(${cur})`, '面数'],
        ['外部', r.external.jobs, r.external.revenue, r.external.cost, r.external.profit, ''],
        ['内部消耗', r.internal.jobs, '', r.internal.cost, '', r.internal.pages],
        ['作废核销', r.writeoff.jobs, '', r.writeoff.cost, '', ''],
        ['全月合计', r.jobs_done, '', '', '', r.pages],
      ])
      return sendCsv(reply, `monthly-${month}.csv`, csv)
    },
  )

  app.get(
    '/api/reports/equipment-usage/export',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req, reply) => {
      const month = monthOf(req.query)
      const { printers } = equipmentUsage(db, month)
      const csv = toCsv([
        ['机台', '名称', '状态', '本月面数', '累计面数', '本月作业数'],
        ...printers.map((p) => [p.code, p.name, p.status, p.month_pages, p.total_pages, p.month_jobs]),
      ])
      return sendCsv(reply, `equipment-usage-${month}.csv`, csv)
    },
  )

  app.get(
    '/api/reports/paper-consumption/export',
    { preHandler: requireAdmin, schema: { querystring: MONTH_QUERY } },
    async (req, reply) => {
      const month = monthOf(req.query)
      const { rows } = paperConsumption(db, month)
      const csv = toCsv([
        ['纸张ID', '名称', '尺寸', '消耗(张)', '废品(张)', '合计(张)'],
        ...rows.map((r) => [r.paper_id, r.name, r.size_key, r.consumed, r.scrapped, r.total]),
      ])
      return sendCsv(reply, `paper-consumption-${month}.csv`, csv)
    },
  )

  // 趋势数据：最近 6 个月汇总（Dashboard 图表用）——单条 GROUP BY SQL
  app.get('/api/reports/trend', { preHandler: requireAdmin }, async () => {
    const now = new Date()
    const startMonth = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().slice(0, 7)
    const months: string[] = []
    for (let i = 5; i >= 0; i--) {
      months.push(new Date(now.getFullYear(), now.getMonth() - i, 1).toISOString().slice(0, 7))
    }

    const rows = db
      .prepare(
        `SELECT substr(j.completed_at, 1, 7) AS month,
                COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN j.quoted_price END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN j.total_cost END), 0) AS cost,
                COALESCE(SUM(CASE WHEN j.quoted_price IS NOT NULL AND COALESCE(o.status,'') != 'cancelled' THEN j.profit END), 0) AS profit,
                COALESCE(SUM(CASE WHEN j.quoted_price IS NULL THEN j.total_cost END), 0) AS internal_cost
         FROM jobs j
         LEFT JOIN order_items oi ON oi.id = j.order_item_id
         LEFT JOIN orders o ON o.id = oi.order_id
         WHERE j.status = 'done' AND substr(j.completed_at, 1, 7) >= ?
         GROUP BY substr(j.completed_at, 1, 7)
         ORDER BY month`,
      )
      .all(startMonth) as Array<{
      month: string; revenue: number; cost: number; profit: number; internal_cost: number
    }>

    const dataMap = new Map(rows.map((r) => [r.month, r]))
    const currency = baseCurrency(db)
    return months.map((m) => {
      const r = dataMap.get(m)
      const revenue = r?.revenue ?? 0
      const cost = r?.cost ?? 0
      const profit = r?.profit ?? 0
      const internal_cost = r?.internal_cost ?? 0
      return {
        month: m,
        revenue,
        cost,
        profit,
        internal_cost,
        revenue_display: formatMoney(money(revenue), currency),
        cost_display: formatMoney(money(cost), currency),
        profit_display: formatMoney(money(profit), currency),
      }
    })
  })

  // D34 历史快照列表（admin）：月初 timer 归档，按月倒序
  app.get('/api/reports/snapshots', { preHandler: requireAdmin }, async () => {
    const currency = baseCurrency(db)
    return listSnapshots(db).map((s) => ({
      ...s,
      ext_revenue_display: formatMoney(money(s.ext_revenue), currency),
      ext_cost_display: formatMoney(money(s.ext_cost), currency),
      ext_profit_display: formatMoney(money(s.ext_profit), currency),
      int_cost_display: formatMoney(money(s.int_cost), currency),
    }))
  })
}
