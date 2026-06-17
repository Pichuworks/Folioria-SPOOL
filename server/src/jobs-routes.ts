import { randomUUID } from 'node:crypto'
import { type FastifyInstance } from 'fastify'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { assertJobCostFields } from './db-guards.js'
import { isConstraint } from './errors.js'
import { requireAdmin } from './guards.js'
import { availability, canTransition, completeJob, JobError, recommendMachines, scheduleBoard } from './jobs.js'
import { tryAdvanceToPrinted } from './orders.js'
import { formatMoney, formatMoneyC, lineTotal, money, moneyC, type Currency } from './money.js'
import { deriveUnitCost, overheadC } from './pricing.js'

const displayOrNull = (amount: unknown, currency: Currency): string | null =>
  amount == null ? null : formatMoney(money(amount as number), currency)

export function registerJobsRoutes(app: FastifyInstance, db: DB): void {
  app.get(
    '/api/jobs',
    {
      preHandler: requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['draft', 'queued', 'printing', 'done', 'cancelled'],
            },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      const { status, offset = 0, limit = 50 } = req.query as { status?: string; offset?: number; limit?: number }
      const statusClause = status ? 'WHERE j.status = ?' : ''
      const statusParams = status ? [status] : []
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM jobs j ${statusClause}`).get(...statusParams) as { n: number }).n
      const sql = `SELECT j.*, m.name AS mode_name, p.name AS paper_name,
                          obc.order_book_id AS order_book_id, ob.name AS book_name, obc.role AS book_role
                   FROM jobs j
                   JOIN print_modes m ON m.id = j.mode_id
                   JOIN papers p ON p.id = j.paper_id
                   LEFT JOIN order_book_components obc ON obc.job_id = j.id
                   LEFT JOIN order_books ob ON ob.id = obc.order_book_id
                   ${statusClause}
                   ORDER BY j.created_at DESC LIMIT ? OFFSET ?`
      const rows = db.prepare(sql).all(...statusParams, limit, offset) as Array<Record<string, unknown>>
      for (const r of rows) assertJobCostFields(r)
      const currency = baseCurrency(db)
      return {
        data: rows.map((r) => ({
          ...r,
          total_cost_display: displayOrNull(r['total_cost'], currency),
          profit_display: displayOrNull(r['profit'], currency),
          quoted_price_display: displayOrNull(r['quoted_price'], currency),
        })),
        total,
      }
    },
  )

  // B4 按机台排产板（只读）：泳道 + due_date + 离线压活告警
  app.get('/api/jobs/board', { preHandler: requireAdmin }, async () => scheduleBoard(db))

  app.get('/api/jobs/availability', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { paper_id?: string; size_key?: string }
    const paperId = Number(q.paper_id)
    if (!Number.isSafeInteger(paperId) || paperId < 1 || !q.size_key) {
      return reply.status(422).send({ error: 'paper_id_and_size_key_required' })
    }
    return availability(db, paperId, q.size_key)
  })

  app.get('/api/jobs/preview', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as {
      mode_id?: string
      paper_id?: string
      size_key?: string
      quantity?: string
    }
    const modeId = Number(q.mode_id)
    const paperId = Number(q.paper_id)
    if (!Number.isSafeInteger(modeId) || !Number.isSafeInteger(paperId) || !q.size_key) {
      return reply.status(422).send({ error: 'mode_paper_size_required' })
    }
    const cost = deriveUnitCost(db, modeId, paperId, q.size_key)
    if (!cost) return reply.status(404).send({ error: 'cost_underivable' })
    const printer = db
      .prepare('SELECT printer_id FROM print_modes WHERE id = ?')
      .get(modeId) as { printer_id: number }
    const overhead = overheadC(db, printer.printer_id)
    const avail = availability(db, paperId, q.size_key)
    const unitTotal = moneyC(cost.ink_c + cost.paper_c + overhead)
    const currency = baseCurrency(db)
    const qty = Number(q.quantity)
    const estTotal =
      q.quantity !== undefined && Number.isSafeInteger(qty) && qty >= 1
        ? lineTotal(unitTotal, qty)
        : null
    return {
      ink_c: cost.ink_c,
      paper_c: cost.paper_c,
      overhead_c: overhead,
      unit_total_c: unitTotal,
      ink_display: formatMoneyC(cost.ink_c, currency),
      paper_display: formatMoneyC(cost.paper_c, currency),
      overhead_display: formatMoneyC(overhead, currency),
      unit_total_display: formatMoneyC(unitTotal, currency),
      est_total: estTotal,
      est_total_display: estTotal == null ? null : formatMoney(estTotal, currency),
      ...avail,
    }
  })

  app.post(
    '/api/jobs',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['title', 'mode_id', 'paper_id', 'size_key', 'quantity'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1 },
            mode_id: { type: 'integer', minimum: 1 },
            paper_id: { type: 'integer', minimum: 1 },
            size_key: { type: 'string', minLength: 1 },
            quantity: { type: 'integer', minimum: 1, maximum: 1000000 },
            order_item_id: { type: ['string', 'null'] },
            quoted_price: { type: ['integer', 'null'], minimum: 0 },
            file_url: { type: ['string', 'null'] },
            notes: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        title: string
        mode_id: number
        paper_id: number
        size_key: string
        quantity: number
        order_item_id?: string | null
        quoted_price?: number | null
        file_url?: string | null
        notes?: string | null
      }
      // 防止对已绑作业的 order_item 二次建 job（否则报表重复计收入/毛利）
      if (b.order_item_id != null) {
        const dup = db.prepare('SELECT 1 FROM jobs WHERE order_item_id = ?').get(b.order_item_id)
        if (dup) return reply.status(409).send({ error: 'order_item_already_has_job' })
      }
      const id = randomUUID()
      try {
        db.prepare(
          `INSERT INTO jobs (id, order_item_id, requester_id, title, mode_id, paper_id, size_key,
                             quantity, quoted_price, file_url, notes, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
        ).run(
          id,
          b.order_item_id ?? null,
          req.user?.id ?? '',
          b.title,
          b.mode_id,
          b.paper_id,
          b.size_key,
          b.quantity,
          b.quoted_price ?? null,
          b.file_url ?? null,
          b.notes ?? null,
          new Date().toISOString(),
        )
      } catch (err) {
        if (isConstraint(err, 'FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_mode_paper_or_size' })
        }
        throw err
      }
      const avail = availability(db, b.paper_id, b.size_key)
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>
      return reply.status(201).send({
        ...job,
        availability: avail,
        availability_warning: avail.available < b.quantity,
      })
    },
  )

  // ③⑤ 机器推荐：给定纸×尺寸（可选单/双面），列出能做的机台按 在线→成本→负载 排序
  app.get(
    '/api/jobs/recommend',
    {
      preHandler: requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          required: ['paper_id', 'size_key'],
          additionalProperties: false,
          properties: {
            paper_id: { type: 'string' },
            size_key: { type: 'string' },
            duplex: { type: 'string', enum: ['0', '1'] },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { paper_id: string; size_key: string; duplex?: string }
      const recs = recommendMachines(
        db,
        Number(q.paper_id),
        q.size_key,
        q.duplex === undefined ? undefined : q.duplex === '1',
      )
      const currency = baseCurrency(db)
      return recs.map((r) => ({ ...r, unit_cost_display: formatMoneyC(moneyC(r.unit_cost_c), currency) }))
    },
  )

  // ③⑤ 改派：把作业换到另一台能做的机器（done/cancelled 不可改）；成本快照仍在 done 时按实际机器定格
  app.patch(
    '/api/jobs/:id/mode',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['mode_id'],
          additionalProperties: false,
          properties: { mode_id: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { mode_id } = req.body as { mode_id: number }
      const job = db.prepare('SELECT status, paper_id, size_key FROM jobs WHERE id = ?').get(id) as
        | { status: string; paper_id: number; size_key: string }
        | undefined
      if (!job) return reply.status(404).send({ error: 'job_not_found' })
      if (job.status === 'done' || job.status === 'cancelled') {
        return reply.status(409).send({ error: `not_reassignable_from_${job.status}` })
      }
      // 新机器须能做该 纸×尺寸（尺寸≤max_size ∧ 有纸口径）
      if (!deriveUnitCost(db, mode_id, job.paper_id, job.size_key)) {
        return reply.status(409).send({ error: 'mode_incapable' })
      }
      db.prepare('UPDATE jobs SET mode_id = ? WHERE id = ?').run(mode_id, id)
      return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    },
  )

  app.patch(
    '/api/jobs/:id',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            status: { type: 'string', enum: ['queued', 'printing', 'cancelled'] },
            title: { type: 'string', minLength: 1 },
            quantity: { type: 'integer', minimum: 1, maximum: 1000000 },
            file_url: { type: ['string', 'null'] },
            notes: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
        | { status: string; title: string; quantity: number; file_url: string | null; notes: string | null }
        | undefined
      if (!job) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as {
        status?: string
        title?: string
        quantity?: number
        file_url?: string | null
        notes?: string | null
      }

      const fieldEdits =
        b.title !== undefined || b.quantity !== undefined || 'file_url' in b || 'notes' in b

      // 状态转移与字段编辑互斥：混合 payload 语义含混且无法原子化为单条 UPDATE
      if (b.status !== undefined && fieldEdits) {
        return reply.status(422).send({ error: 'status_and_field_edits_mutually_exclusive' })
      }

      if (b.status !== undefined) {
        if (!canTransition(job.status, b.status)) {
          return reply
            .status(409)
            .send({ error: `invalid_transition_${job.status}_to_${b.status}` })
        }
        const stamp =
          b.status === 'printing'
            ? 'started_at = ?'
            : b.status === 'cancelled'
              ? 'completed_at = ?'
              : null
        if (stamp) {
          db.prepare(`UPDATE jobs SET status = ?, ${stamp} WHERE id = ?`).run(
            b.status,
            new Date().toISOString(),
            id,
          )
        } else {
          db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(b.status, id)
        }
      } else if (fieldEdits) {
        if (job.status !== 'draft') {
          return reply.status(409).send({ error: 'editable_only_in_draft' })
        }
        db.prepare('UPDATE jobs SET title = ?, quantity = ?, file_url = ?, notes = ? WHERE id = ?').run(
          b.title ?? job.title,
          b.quantity ?? job.quantity,
          'file_url' in b ? (b.file_url ?? null) : job.file_url,
          'notes' in b ? (b.notes ?? null) : job.notes,
          id,
        )
      }
      return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    },
  )

  app.post(
    '/api/jobs/:id/done',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            waste_quantity: { type: 'integer', minimum: 0 },
            pages_consumed: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const b = req.body as { waste_quantity?: number; pages_consumed?: number }
      try {
        completeJob(db, id, {
          wasteQuantity: b.waste_quantity ?? 0,
          pagesConsumed: b.pages_consumed,
          operatorId: req.user?.id,
        })
      } catch (err) {
        if (err instanceof JobError) {
          return reply.status(err.statusCode).send({ error: err.message })
        }
        throw err
      }
      tryAdvanceToPrinted(db, id)
      return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    },
  )
}
