import { randomUUID } from 'node:crypto'
import { type FastifyInstance } from 'fastify'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'

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
  app.get('/api/equipment', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT * FROM printers WHERE archived = 0 ORDER BY id').all(),
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
