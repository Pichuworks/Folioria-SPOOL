import { type FastifyInstance } from 'fastify'
import { calibrationDue, raiseAlert, resolveAlert } from './alerts.js'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'

export function registerAlertsRoutes(app: FastifyInstance, db: DB): void {
  app.get(
    '/api/alerts',
    {
      preHandler: requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            all: { type: 'string' },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
        },
      },
    },
    async (req) => {
      const { all, offset = 0, limit = 100 } = req.query as { all?: string; offset?: number; limit?: number }
      if (all === '1') {
        const total = (db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number }).n
        const data = db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)
        return { data, total }
      }
      const total = (db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL').get() as { n: number }).n
      const data = db.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)
      return { data, total }
    },
  )

  // 通知投递留痕只读视图（admin）：暴露 sent/failed/skipped，让静默失败/跳过可见
  app.get('/api/notifications', { preHandler: requireAdmin }, async () =>
    db
      .prepare(
        'SELECT id, event, channel, recipient, status, error, sent_at FROM notification_log ORDER BY sent_at DESC LIMIT 200',
      )
      .all(),
  )

  app.patch('/api/alerts/:id/acknowledge', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { changes } = db
      .prepare('UPDATE alerts SET acknowledged = 1, acknowledged_by = ? WHERE id = ?')
      .run(req.user?.id ?? null, id)
    if (changes === 0) return reply.status(404).send({ error: 'not_found' })
    return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id)
  })

  app.patch('/api/alerts/:id/resolve', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const exists = db.prepare('SELECT resolved_at FROM alerts WHERE id = ?').get(id) as
      | { resolved_at: string | null }
      | undefined
    if (!exists) return reply.status(404).send({ error: 'not_found' })
    if (!resolveAlert(db, id)) return reply.status(409).send({ error: 'already_resolved' })
    return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id)
  })

  /** 全量阈值扫描：库存低 / 耗材阈值 / 校准双触发（dashboard 与定时任务入口） */
  app.post(
    '/api/alerts/scan',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { low_stock_threshold: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (req) => {
      const threshold = (req.body as { low_stock_threshold?: number }).low_stock_threshold ?? 50
      return db.transaction(() => {
        let lowStock = 0
        const stocks = db
          .prepare(
            `SELECT ps.id, ps.quantity, p.name, ps.size_key FROM paper_stocks ps
             JOIN papers p ON p.id = ps.paper_id WHERE ps.archived = 0 AND ps.quantity <= ?`,
          )
          .all(threshold) as Array<{ id: string; quantity: number; name: string; size_key: string }>
        for (const s of stocks) {
          raiseAlert(db, {
            type: 'low_stock',
            severity: s.quantity <= 0 ? 'critical' : 'warning',
            target_type: 'paper_stock',
            target_id: s.id,
            message: `${s.name} ${s.size_key} 账面 ${s.quantity}（阈值 ${threshold}）`,
          })
          lowStock += 1
        }

        let consumableLow = 0
        const consumables = db
          .prepare(
            `SELECT id, name, rated_life_pages, current_usage_pages, alert_threshold_bp
             FROM consumables WHERE cost_model = 'per_page' AND archived = 0
               AND rated_life_pages IS NOT NULL AND rated_life_pages > 0`,
          )
          .all() as Array<{
          id: string; name: string; rated_life_pages: number; current_usage_pages: number; alert_threshold_bp: number
        }>
        for (const c of consumables) {
          const left = c.rated_life_pages - c.current_usage_pages
          const num = Math.max(0, left) * 10000
          const remainingBp = (num - (num % c.rated_life_pages)) / c.rated_life_pages
          if (remainingBp <= c.alert_threshold_bp) {
            raiseAlert(db, {
              type: 'consumable_low',
              severity: remainingBp === 0 ? 'critical' : 'warning',
              target_type: 'consumable',
              target_id: c.id,
              message: `${c.name} 剩余 ${(remainingBp / 100).toFixed(2)}%（阈值 ${(c.alert_threshold_bp / 100).toFixed(2)}%）`,
            })
            consumableLow += 1
          }
        }

        let calibration = 0
        const now = new Date()
        const printers = db
          .prepare(
            `SELECT id, code, total_pages, last_calibration_at, last_calibration_pages,
                    calibration_interval_pages, calibration_interval_days
             FROM printers WHERE archived = 0`,
          )
          .all() as Array<{
          id: number; code: string; total_pages: number; last_calibration_at: string | null
          last_calibration_pages: number; calibration_interval_pages: number | null; calibration_interval_days: number | null
        }>
        for (const p of printers) {
          if (calibrationDue(p, now)) {
            raiseAlert(db, {
              type: 'calibration_due',
              severity: 'warning',
              target_type: 'printer',
              target_id: String(p.id),
              message: `${p.code} 校准到期（页数 ${p.total_pages - p.last_calibration_pages} / 上次 ${p.last_calibration_at ?? '未记录'}）`,
            })
            calibration += 1
          }
        }

        return { low_stock: lowStock, consumable_low: consumableLow, calibration_due: calibration }
      })()
    },
  )
}
