import { type FastifyInstance } from 'fastify'
import { checkCalibration, checkConsumableThreshold, raiseAlert, resolveAlert } from './alerts.js'
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
          properties: { all: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const { all } = req.query as { all?: string }
      return all === '1'
        ? db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 500').all()
        : db
            .prepare('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC')
            .all()
    },
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
      let lowStock = 0
      const stocks = db
        .prepare(
          `SELECT ps.id, ps.quantity, p.name, ps.size_key FROM paper_stocks ps
           JOIN papers p ON p.id = ps.paper_id WHERE ps.archived = 0`,
        )
        .all() as Array<{ id: string; quantity: number; name: string; size_key: string }>
      for (const s of stocks) {
        if (s.quantity <= threshold) {
          raiseAlert(db, {
            type: 'low_stock',
            severity: s.quantity <= 0 ? 'critical' : 'warning',
            target_type: 'paper_stock',
            target_id: s.id,
            message: `${s.name} ${s.size_key} 账面 ${s.quantity}（阈值 ${threshold}）`,
          })
          lowStock += 1
        }
      }

      let consumableLow = 0
      const consumables = db
        .prepare("SELECT id FROM consumables WHERE cost_model = 'per_page' AND archived = 0")
        .all() as Array<{ id: string }>
      for (const c of consumables) {
        if (checkConsumableThreshold(db, c.id)) consumableLow += 1
      }

      let calibration = 0
      const printers = db.prepare('SELECT id FROM printers WHERE archived = 0').all() as Array<{
        id: number
      }>
      for (const p of printers) {
        if (checkCalibration(db, p.id)) calibration += 1
      }

      return { low_stock: lowStock, consumable_low: consumableLow, calibration_due: calibration }
    },
  )
}
