import { randomUUID } from 'node:crypto'
import { type FastifyInstance } from 'fastify'
import { calibrationDue } from './alerts.js'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'

interface PrinterRow {
  id: number
  code: string
  total_pages: number
  last_calibration_at: string | null
  last_calibration_pages: number
  calibration_interval_pages: number | null
  calibration_interval_days: number | null
}

const MAINT_TYPES = [
  'calibration',
  'toner_change',
  'nozzle_check',
  'head_clean',
  'fuser_replace',
  'drum_replace',
  'firmware_update',
  'deep_clean',
  'other',
] as const

export function registerEquipmentRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/equipment', { preHandler: requireAdmin }, async () => {
    const now = new Date()
    const rows = db.prepare('SELECT * FROM printers WHERE archived = 0 ORDER BY id').all() as PrinterRow[]
    return rows.map((p) => ({ ...p, calibration_due: calibrationDue(p, now) }))
  })

  app.get('/api/equipment/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const p = db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as PrinterRow | undefined
    if (!p) return reply.status(404).send({ error: 'not_found' })
    return { ...p, calibration_due: calibrationDue(p, new Date()) }
  })

  app.patch(
    '/api/equipment/:id',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1 },
            location: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['online', 'standby', 'maintenance', 'offline'] },
            equipment_cost_c: { type: 'integer', minimum: 0 },
            monthly_cost_c: { type: 'integer', minimum: 0 },
            calibration_interval_pages: { type: ['integer', 'null'], minimum: 1 },
            calibration_interval_days: { type: ['integer', 'null'], minimum: 1 },
            archived: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const existing = db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as Record<string, unknown>
      const merged = { ...existing, ...b }
      if (typeof b['archived'] === 'boolean') merged['archived'] = b['archived'] ? 1 : 0
      db.prepare(
        `UPDATE printers SET name=@name, location=@location, status=@status,
           equipment_cost_c=@equipment_cost_c, monthly_cost_c=@monthly_cost_c,
           calibration_interval_pages=@calibration_interval_pages,
           calibration_interval_days=@calibration_interval_days, archived=@archived
         WHERE id=@id`,
      ).run(merged)
      const p = db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as PrinterRow
      return { ...p, calibration_due: calibrationDue(p, new Date()) }
    },
  )

  app.get('/api/equipment/:id/maintenance', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!db.prepare('SELECT 1 FROM printers WHERE id = ?').get(id)) {
      return reply.status(404).send({ error: 'not_found' })
    }
    return db
      .prepare('SELECT * FROM maintenance_events WHERE printer_id = ? ORDER BY occurred_at DESC')
      .all(id)
  })

  app.post(
    '/api/equipment/:id/maintenance',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: [...MAINT_TYPES] },
            occurred_at: { type: 'string' },
            notes: { type: ['string', 'null'] },
            next_due: { type: ['string', 'null'] },
            cost: { type: ['integer', 'null'], minimum: 0 },
            final_usage: { type: ['integer', 'null'], minimum: 0 },
            consumable_id: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const printerId = Number((req.params as { id: string }).id)
      if (!db.prepare('SELECT 1 FROM printers WHERE id = ?').get(printerId)) {
        return reply.status(404).send({ error: 'not_found' })
      }
      const b = req.body as {
        type: string
        occurred_at?: string
        notes?: string | null
        next_due?: string | null
        cost?: number | null
        final_usage?: number | null
        consumable_id?: string
      }
      const now = new Date().toISOString()
      const eventId = randomUUID()
      const insertEvent = db.prepare(
        `INSERT INTO maintenance_events (id, printer_id, type, occurred_at, operator_id,
                                         notes, next_due, cost, final_usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )

      if (b.type === 'toner_change') {
        // C2 换装流程：事件落档 + 在役件清零换新 + 备品 −1，单事务
        if (!b.consumable_id || b.final_usage == null) {
          return reply.status(422).send({ error: 'toner_change_requires_consumable_and_final_usage' })
        }
        const consumable = db
          .prepare('SELECT quantity, printer_id FROM consumables WHERE id = ? AND archived = 0')
          .get(b.consumable_id) as { quantity: number; printer_id: number } | undefined
        if (!consumable) return reply.status(404).send({ error: 'consumable_not_found' })
        if (consumable.printer_id !== printerId) {
          return reply.status(422).send({ error: 'consumable_printer_mismatch' })
        }
        if (consumable.quantity < 1) {
          return reply.status(409).send({ error: 'no_spare_in_stock' })
        }
        db.transaction(() => {
          insertEvent.run(
            eventId,
            printerId,
            b.type,
            b.occurred_at ?? now,
            req.user?.id ?? null,
            b.notes ?? null,
            b.next_due ?? null,
            b.cost ?? null,
            b.final_usage,
          )
          db.prepare(
            `UPDATE consumables
             SET current_usage_pages = 0, installed_at = ?, quantity = quantity - 1
             WHERE id = ?`,
          ).run(now, b.consumable_id)
          db.prepare(
            `INSERT INTO inventory_log (id, target_type, target_id, action, quantity_delta,
                                        reason, operator_id, related_job_id, created_at)
             VALUES (?, 'consumable', ?, 'consume', -1, ?, ?, NULL, ?)`,
          ).run(randomUUID(), b.consumable_id, `toner_change ${eventId}`, req.user?.id ?? null, now)
        })()
      } else if (b.type === 'calibration') {
        // C6：校准事件重置双触发基线，并解决未关闭的 calibration_due 提醒
        const occurredAt = b.occurred_at ?? now
        db.transaction(() => {
          insertEvent.run(
            eventId,
            printerId,
            b.type,
            occurredAt,
            req.user?.id ?? null,
            b.notes ?? null,
            b.next_due ?? null,
            b.cost ?? null,
            null,
          )
          db.prepare(
            `UPDATE printers SET last_calibration_at = ?, last_calibration_pages = total_pages
             WHERE id = ?`,
          ).run(occurredAt, printerId)
          db.prepare(
            `UPDATE alerts SET resolved_at = ?
             WHERE target_type = 'printer' AND target_id = ? AND type = 'calibration_due'
               AND resolved_at IS NULL`,
          ).run(now, String(printerId))
        })()
      } else {
        insertEvent.run(
          eventId,
          printerId,
          b.type,
          b.occurred_at ?? now,
          req.user?.id ?? null,
          b.notes ?? null,
          b.next_due ?? null,
          b.cost ?? null,
          b.final_usage ?? null,
        )
      }
      return reply
        .status(201)
        .send(db.prepare('SELECT * FROM maintenance_events WHERE id = ?').get(eventId))
    },
  )
}
