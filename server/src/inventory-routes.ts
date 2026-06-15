import { randomUUID } from 'node:crypto'
import { type FastifyInstance } from 'fastify'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'
import { formatMoneyC, moneyC } from './money.js'
import { sendXlsx } from './xlsx.js'

const MOVEMENT_ACTIONS = ['purchase', 'consume', 'adjust', 'scrap', 'return'] as const
type MovementAction = (typeof MOVEMENT_ACTIONS)[number]

/** 寿命剩余基点（非金额，整数 floor）：per_page 专用，其余 null */
function remainingBp(costModel: string, rated: number | null, usage: number): number | null {
  if (costModel !== 'per_page' || rated == null || rated <= 0) return null
  const left = rated - usage
  if (left <= 0) return 0
  const num = left * 10000
  return (num - (num % rated)) / rated
}

interface MovementBody {
  action: MovementAction
  quantity_delta: number
  reason?: string
  original_currency?: string
  original_amount?: number
  converted_cost_c?: number
  exchange_rate_note?: string
}

export function registerInventoryRoutes(app: FastifyInstance, db: DB): void {
  // ---------- locations ----------

  app.get('/api/inventory/locations', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT * FROM locations ORDER BY id').all(),
  )

  app.post(
    '/api/inventory/locations',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1 },
            sensor_id: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { id: string; sensor_id?: string | null }
      try {
        db.prepare('INSERT INTO locations (id, sensor_id) VALUES (?, ?)').run(b.id, b.sensor_id ?? null)
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          return reply.status(409).send({ error: 'location_exists' })
        }
        throw err
      }
      return reply.status(201).send(db.prepare('SELECT * FROM locations WHERE id = ?').get(b.id))
    },
  )

  app.patch(
    '/api/inventory/locations/:id',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            sensor_id: { type: ['string', 'null'] },
            moisture_status: { type: 'string', enum: ['ok', 'warning', 'danger'] },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as
        | { sensor_id: string | null; moisture_status: string }
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as { sensor_id?: string | null; moisture_status?: string }
      db.prepare('UPDATE locations SET sensor_id = ?, moisture_status = ? WHERE id = ?').run(
        'sensor_id' in b ? (b.sensor_id ?? null) : existing.sensor_id,
        b.moisture_status ?? existing.moisture_status,
        id,
      )
      return db.prepare('SELECT * FROM locations WHERE id = ?').get(id)
    },
  )

  // ---------- paper_stocks ----------

  app.get('/api/inventory/stocks', { preHandler: requireAdmin }, async () =>
    db
      .prepare(
        `SELECT ps.*, p.name AS paper_name, s.label AS size_label,
                COALESCE(l.moisture_status, 'ok') AS moisture_status
         FROM paper_stocks ps
         JOIN papers p ON p.id = ps.paper_id
         JOIN sizes s ON s.key = ps.size_key
         LEFT JOIN locations l ON l.id = ps.location_id
         WHERE ps.archived = 0
         ORDER BY p.id, s.sort`,
      )
      .all(),
  )

  app.post(
    '/api/inventory/stocks',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['paper_id', 'size_key'],
          additionalProperties: false,
          properties: {
            paper_id: { type: 'integer', minimum: 1 },
            size_key: { type: 'string', minLength: 1 },
            location_id: { type: ['string', 'null'] },
            notes: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        paper_id: number
        size_key: string
        location_id?: string | null
        notes?: string | null
      }
      const id = randomUUID()
      const locationId = b.location_id ?? null
      if (locationId !== null && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locationId)) {
        db.prepare('INSERT INTO locations (id) VALUES (?)').run(locationId)
      }
      try {
        db.prepare(
          `INSERT INTO paper_stocks (id, paper_id, size_key, quantity, location_id, notes)
           VALUES (?, ?, ?, 0, ?, ?)`,
        ).run(id, b.paper_id, b.size_key, locationId, b.notes ?? null)
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          return reply.status(409).send({ error: 'stock_exists' })
        }
        if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_paper_or_size' })
        }
        throw err
      }
      return reply.status(201).send(db.prepare('SELECT * FROM paper_stocks WHERE id = ?').get(id))
    },
  )

  app.patch(
    '/api/inventory/stocks/:id',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            location_id: { type: ['string', 'null'] },
            opened: { type: 'boolean' },
            notes: { type: ['string', 'null'] },
            archived: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const existing = db.prepare('SELECT * FROM paper_stocks WHERE id = ?').get(id) as
        | { location_id: string | null; opened: number; opened_at: string | null; notes: string | null; archived: number }
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as {
        location_id?: string | null
        opened?: boolean
        notes?: string | null
        archived?: boolean
      }
      const opened = b.opened === undefined ? existing.opened : b.opened ? 1 : 0
      const openedAt =
        b.opened === undefined ? existing.opened_at : b.opened ? new Date().toISOString() : null
      db.prepare(
        'UPDATE paper_stocks SET location_id = ?, opened = ?, opened_at = ?, notes = ?, archived = ? WHERE id = ?',
      ).run(
        'location_id' in b ? (b.location_id ?? null) : existing.location_id,
        opened,
        openedAt,
        'notes' in b ? (b.notes ?? null) : existing.notes,
        b.archived === undefined ? existing.archived : b.archived ? 1 : 0,
        id,
      )
      return db.prepare('SELECT * FROM paper_stocks WHERE id = ?').get(id)
    },
  )

  // ---------- 出入库（事件溯源；convert 除外） ----------

  app.post(
    '/api/inventory/stocks/:id/movements',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['action', 'quantity_delta'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: [...MOVEMENT_ACTIONS] },
            quantity_delta: { type: 'integer' },
            reason: { type: ['string', 'null'] },
            original_currency: { type: 'string', minLength: 3, maxLength: 3 },
            original_amount: { type: 'integer', minimum: 0 },
            converted_cost_c: { type: 'integer', minimum: 0 },
            exchange_rate_note: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const b = req.body as MovementBody

      if (b.quantity_delta === 0) return reply.status(422).send({ error: 'zero_delta' })
      const signOk =
        b.action === 'adjust' ||
        (['purchase', 'return'].includes(b.action) && b.quantity_delta > 0) ||
        (['consume', 'scrap'].includes(b.action) && b.quantity_delta < 0)
      if (!signOk) return reply.status(422).send({ error: 'delta_sign_mismatch' })

      const hasCurrencyFields =
        b.original_currency !== undefined ||
        b.original_amount !== undefined ||
        b.converted_cost_c !== undefined ||
        b.exchange_rate_note !== undefined
      if (hasCurrencyFields && b.action !== 'purchase') {
        return reply.status(422).send({ error: 'currency_fields_purchase_only' })
      }

      const stock = db.prepare('SELECT quantity FROM paper_stocks WHERE id = ?').get(id) as
        | { quantity: number }
        | undefined
      if (!stock) return reply.status(404).send({ error: 'not_found' })
      if (stock.quantity + b.quantity_delta < 0) {
        return reply.status(409).send({ error: 'insufficient_stock' })
      }

      const logId = randomUUID()
      db.transaction(() => {
        db.prepare('UPDATE paper_stocks SET quantity = quantity + ? WHERE id = ?').run(
          b.quantity_delta,
          id,
        )
        db.prepare(
          `INSERT INTO inventory_log (id, target_type, target_id, action, quantity_delta, reason,
                                      operator_id, original_currency, original_amount,
                                      converted_cost_c, exchange_rate_note, created_at)
           VALUES (?, 'paper_stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          logId,
          id,
          b.action,
          b.quantity_delta,
          b.reason ?? null,
          req.user?.id ?? null,
          b.original_currency ?? null,
          b.original_amount ?? null,
          b.converted_cost_c ?? null,
          b.exchange_rate_note ?? null,
          new Date().toISOString(),
        )
      })()
      return reply.status(201).send(db.prepare('SELECT * FROM inventory_log WHERE id = ?').get(logId))
    },
  )

  // ---------- 裁切转换（C1/D1：成对日志，单条拒绝） ----------

  app.post(
    '/api/inventory/convert',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['from', 'to'],
          additionalProperties: false,
          properties: {
            from: {
              type: 'object',
              required: ['stock_id', 'quantity_delta'],
              additionalProperties: false,
              properties: {
                stock_id: { type: 'string' },
                quantity_delta: { type: 'integer', maximum: -1 },
              },
            },
            to: {
              type: 'object',
              required: ['stock_id', 'quantity_delta'],
              additionalProperties: false,
              properties: {
                stock_id: { type: 'string' },
                quantity_delta: { type: 'integer', minimum: 1 },
              },
            },
            reason: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        from: { stock_id: string; quantity_delta: number }
        to: { stock_id: string; quantity_delta: number }
        reason?: string | null
      }
      if (b.from.stock_id === b.to.stock_id) {
        return reply.status(422).send({ error: 'same_stock' })
      }
      const fromStock = db
        .prepare('SELECT quantity, paper_id FROM paper_stocks WHERE id = ?')
        .get(b.from.stock_id) as { quantity: number; paper_id: number } | undefined
      const toStock = db.prepare('SELECT paper_id FROM paper_stocks WHERE id = ?').get(b.to.stock_id) as
        | { paper_id: number }
        | undefined
      if (!fromStock || !toStock) return reply.status(404).send({ error: 'not_found' })
      // S4/D1: 裁切只允许同纸不同尺寸折算，跨纸种拒绝
      if (fromStock.paper_id !== toStock.paper_id) {
        return reply.status(422).send({ error: 'cross_paper' })
      }
      if (fromStock.quantity + b.from.quantity_delta < 0) {
        return reply.status(409).send({ error: 'insufficient_stock' })
      }

      const group = randomUUID()
      const now = new Date().toISOString()
      const insertLog = db.prepare(
        `INSERT INTO inventory_log (id, target_type, target_id, action, quantity_delta,
                                    convert_group, reason, operator_id, created_at)
         VALUES (?, 'paper_stock', ?, 'convert', ?, ?, ?, ?, ?)`,
      )
      db.transaction(() => {
        db.prepare('UPDATE paper_stocks SET quantity = quantity + ? WHERE id = ?').run(
          b.from.quantity_delta,
          b.from.stock_id,
        )
        db.prepare('UPDATE paper_stocks SET quantity = quantity + ? WHERE id = ?').run(
          b.to.quantity_delta,
          b.to.stock_id,
        )
        insertLog.run(randomUUID(), b.from.stock_id, b.from.quantity_delta, group, b.reason ?? null, req.user?.id ?? null, now)
        insertLog.run(randomUUID(), b.to.stock_id, b.to.quantity_delta, group, b.reason ?? null, req.user?.id ?? null, now)
      })()
      return reply.status(201).send({ convert_group: group })
    },
  )

  // ---------- consumables（C2：单表 + cost_model 区分） ----------

  app.get('/api/inventory/consumables', { preHandler: requireAdmin }, async () => {
    const currency = baseCurrency(db)
    const rows = db
      .prepare(
        `SELECT c.*, p.code AS printer_code, p.name AS printer_name
         FROM consumables c JOIN printers p ON p.id = c.printer_id
         WHERE c.archived = 0 ORDER BY p.id, c.name`,
      )
      .all() as Array<{
      cost_model: string
      rated_life_pages: number | null
      current_usage_pages: number
      unit_cost_c: number
    }>
    return rows.map((r) => ({
      ...r,
      remaining_bp: remainingBp(r.cost_model, r.rated_life_pages, r.current_usage_pages),
      unit_cost_display: formatMoneyC(moneyC(r.unit_cost_c), currency),
    }))
  })

  app.post(
    '/api/inventory/consumables',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'type', 'printer_id', 'cost_model', 'unit_cost_c'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
            type: { type: 'string', enum: ['toner', 'ink', 'printhead', 'fuser', 'drum', 'other'] },
            printer_id: { type: 'integer', minimum: 1 },
            quantity: { type: 'integer', minimum: 0 },
            cost_model: { type: 'string', enum: ['per_page', 'per_job_rule'] },
            rated_life_pages: { type: ['integer', 'null'], minimum: 1 },
            unit_cost_c: { type: 'integer', minimum: 0 },
            supplier: { type: ['string', 'null'] },
            alert_threshold_bp: { type: 'integer', minimum: 0, maximum: 10000 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        name: string
        type: string
        printer_id: number
        quantity?: number
        cost_model: string
        rated_life_pages?: number | null
        unit_cost_c: number
        supplier?: string | null
        alert_threshold_bp?: number
      }
      if (b.cost_model === 'per_page' && b.rated_life_pages == null) {
        return reply.status(422).send({ error: 'rated_life_pages_required' })
      }
      const id = randomUUID()
      try {
        db.prepare(
          `INSERT INTO consumables (id, name, type, printer_id, quantity, cost_model,
                                    rated_life_pages, unit_cost_c, supplier, alert_threshold_bp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          b.name,
          b.type,
          b.printer_id,
          b.quantity ?? 0,
          b.cost_model,
          b.rated_life_pages ?? null,
          b.unit_cost_c,
          b.supplier ?? null,
          b.alert_threshold_bp ?? 2000,
        )
      } catch (err) {
        if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_printer' })
        }
        throw err
      }
      const row = db.prepare('SELECT * FROM consumables WHERE id = ?').get(id) as {
        cost_model: string
        rated_life_pages: number | null
        current_usage_pages: number
      }
      return reply.status(201).send({
        ...row,
        remaining_bp: remainingBp(row.cost_model, row.rated_life_pages, row.current_usage_pages),
      })
    },
  )

  app.patch(
    '/api/inventory/consumables/:id',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1 },
            quantity: { type: 'integer', minimum: 0 },
            rated_life_pages: { type: ['integer', 'null'], minimum: 1 },
            unit_cost_c: { type: 'integer', minimum: 0 },
            supplier: { type: ['string', 'null'] },
            alert_threshold_bp: { type: 'integer', minimum: 0, maximum: 10000 },
            archived: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const existing = db.prepare('SELECT * FROM consumables WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as Record<string, unknown>
      const merged = { ...existing, ...b }
      if (typeof b['archived'] === 'boolean') merged['archived'] = b['archived'] ? 1 : 0
      if (merged['cost_model'] === 'per_page' && merged['rated_life_pages'] == null) {
        return reply.status(422).send({ error: 'rated_life_pages_required' })
      }
      db.prepare(
        `UPDATE consumables SET name=@name, quantity=@quantity, rated_life_pages=@rated_life_pages,
           unit_cost_c=@unit_cost_c, supplier=@supplier, alert_threshold_bp=@alert_threshold_bp,
           archived=@archived WHERE id=@id`,
      ).run(merged)
      return db.prepare('SELECT * FROM consumables WHERE id = ?').get(id)
    },
  )

  // ---------- 日志查询 ----------

  app.get(
    '/api/inventory/log',
    {
      preHandler: requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target_type: { type: 'string', enum: ['paper_stock', 'consumable'] },
            target_id: { type: 'string' },
            action: {
              type: 'string',
              enum: ['purchase', 'consume', 'adjust', 'scrap', 'return', 'convert'],
            },
            from: { type: 'string' },
            to: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as Partial<Record<'target_type' | 'target_id' | 'action' | 'from' | 'to', string>>
      const where: string[] = []
      const params: Record<string, string> = {}
      if (q.target_type) {
        where.push('target_type = @target_type')
        params['target_type'] = q.target_type
      }
      if (q.target_id) {
        where.push('target_id = @target_id')
        params['target_id'] = q.target_id
      }
      if (q.action) {
        where.push('action = @action')
        params['action'] = q.action
      }
      if (q.from) {
        where.push('created_at >= @from')
        params['from'] = q.from
      }
      if (q.to) {
        where.push('created_at <= @to')
        params['to'] = q.to
      }
      const sql = `SELECT * FROM inventory_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`
      return db.prepare(sql).all(params)
    },
  )

  // ---------- xlsx exports ----------

  app.get('/api/inventory/stocks/export', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = db
      .prepare(
        `SELECT ps.id, p.name AS paper_name, s.label AS size_label, ps.quantity,
                ps.location_id, l.moisture_status, ps.opened, ps.opened_at, ps.notes
         FROM paper_stocks ps
         JOIN papers p ON p.id = ps.paper_id
         JOIN sizes s ON s.key = ps.size_key
         LEFT JOIN locations l ON l.id = ps.location_id
         WHERE ps.archived = 0
         ORDER BY p.name, s.sort`,
      )
      .all()
    return sendXlsx(reply, 'stocks.xlsx', [
      {
        name: '纸张库存',
        columns: [
          { header: '纸张', key: 'paper_name', width: 20 },
          { header: '尺寸', key: 'size_label', width: 10 },
          { header: '数量(张)', key: 'quantity', width: 12 },
          { header: '存放位置', key: 'location_id', width: 18 },
          { header: '湿度状态', key: 'moisture_status', width: 10 },
          { header: '已拆封', key: 'opened', width: 8 },
          { header: '拆封时间', key: 'opened_at', width: 20 },
          { header: '备注', key: 'notes', width: 25 },
        ],
        rows,
      },
    ])
  })

  app.get('/api/inventory/consumables/export', { preHandler: requireAdmin }, async (_req, reply) => {
    const currency = baseCurrency(db)
    const rows = db
      .prepare(
        `SELECT c.name, c.type, p.code AS printer_code, c.quantity,
                c.cost_model, c.rated_life_pages, c.current_usage_pages,
                c.unit_cost_c, c.supplier, c.alert_threshold_bp
         FROM consumables c
         JOIN printers p ON p.id = c.printer_id
         WHERE c.archived = 0
         ORDER BY p.id, c.name`,
      )
      .all() as Array<{
      unit_cost_c: number
      cost_model: string
      rated_life_pages: number | null
      current_usage_pages: number
    }>
    return sendXlsx(reply, 'consumables.xlsx', [
      {
        name: '耗材库存',
        columns: [
          { header: '名称', key: 'name', width: 20 },
          { header: '类型', key: 'type', width: 10 },
          { header: '关联设备', key: 'printer_code', width: 12 },
          { header: '备品数', key: 'quantity', width: 8 },
          { header: '计费模式', key: 'cost_model', width: 12 },
          { header: '额定寿命(页)', key: 'rated_life_pages', width: 14 },
          { header: '已用(页)', key: 'current_usage_pages', width: 10 },
          { header: '单价', key: 'unit_cost_display', width: 12 },
          { header: '供应商', key: 'supplier', width: 15 },
        ],
        rows: rows.map((r) => ({
          ...r,
          unit_cost_display: formatMoneyC(moneyC(r.unit_cost_c), currency),
        })),
      },
    ])
  })

  app.get('/api/inventory/log/export', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Partial<Record<'target_type' | 'target_id' | 'action' | 'from' | 'to', string>>
    const where: string[] = []
    const params: Record<string, string> = {}
    if (q.target_type) { where.push('target_type = @target_type'); params['target_type'] = q.target_type }
    if (q.target_id) { where.push('target_id = @target_id'); params['target_id'] = q.target_id }
    if (q.action) { where.push('action = @action'); params['action'] = q.action }
    if (q.from) { where.push('created_at >= @from'); params['from'] = q.from }
    if (q.to) { where.push('created_at <= @to'); params['to'] = q.to }
    const sql = `SELECT * FROM inventory_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 5000`
    const rows = db.prepare(sql).all(params)
    return sendXlsx(reply, 'inventory-log.xlsx', [
      {
        name: '出入库记录',
        columns: [
          { header: '时间', key: 'created_at', width: 20 },
          { header: '操作', key: 'action', width: 10 },
          { header: '对象类型', key: 'target_type', width: 14 },
          { header: '对象ID', key: 'target_id', width: 20 },
          { header: '数量变化', key: 'quantity_delta', width: 12 },
          { header: '转换组', key: 'convert_group', width: 20 },
          { header: '原因', key: 'reason', width: 25 },
        ],
        rows,
      },
    ])
  })
}
