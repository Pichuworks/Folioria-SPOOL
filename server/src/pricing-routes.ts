import { type FastifyInstance } from 'fastify'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'
import { formatMoney, formatMoneyC, lineTotal } from './money.js'
import { listQuotable, quote } from './pricing.js'

const MONEY_C = { type: 'integer', minimum: 0 }
const ID_PARAM = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^\\d+$' } },
}

const isConstraint = (err: unknown, kind: string): boolean =>
  err instanceof Error && err.message.includes(kind)

export function registerPricingRoutes(app: FastifyInstance, db: DB): void {
  // ---------- 管理域: sizes ----------

  app.get('/api/pricing/sizes', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT key, label, area, sort FROM sizes ORDER BY sort').all(),
  )

  app.post(
    '/api/pricing/sizes',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['key', 'label', 'area'],
          additionalProperties: false,
          properties: {
            key: { type: 'string', minLength: 1 },
            label: { type: 'string', minLength: 1 },
            area: { type: 'number', exclusiveMinimum: 0 },
            sort: { type: 'integer' },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { key: string; label: string; area: number; sort?: number }
      try {
        db.prepare('INSERT INTO sizes (key, label, area, sort) VALUES (?, ?, ?, ?)').run(
          b.key,
          b.label,
          b.area,
          b.sort ?? 0,
        )
      } catch (err) {
        if (isConstraint(err, 'UNIQUE') || isConstraint(err, 'PRIMARY')) {
          return reply.status(409).send({ error: 'key_exists' })
        }
        throw err
      }
      return reply.status(201).send(db.prepare('SELECT * FROM sizes WHERE key = ?').get(b.key))
    },
  )

  app.patch(
    '/api/pricing/sizes/:key',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            label: { type: 'string', minLength: 1 },
            area: { type: 'number', exclusiveMinimum: 0 },
            sort: { type: 'integer' },
          },
        },
      },
    },
    async (req, reply) => {
      const { key } = req.params as { key: string }
      const existing = db.prepare('SELECT * FROM sizes WHERE key = ?').get(key) as
        | { label: string; area: number; sort: number }
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as Partial<{ label: string; area: number; sort: number }>
      db.prepare('UPDATE sizes SET label = ?, area = ?, sort = ? WHERE key = ?').run(
        b.label ?? existing.label,
        b.area ?? existing.area,
        b.sort ?? existing.sort,
        key,
      )
      return db.prepare('SELECT * FROM sizes WHERE key = ?').get(key)
    },
  )

  app.delete('/api/pricing/sizes/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const { key } = req.params as { key: string }
    try {
      const { changes } = db.prepare('DELETE FROM sizes WHERE key = ?').run(key)
      if (changes === 0) return reply.status(404).send({ error: 'not_found' })
    } catch (err) {
      if (isConstraint(err, 'FOREIGN KEY')) {
        return reply.status(409).send({ error: 'size_in_use' })
      }
      throw err
    }
    return reply.status(204).send()
  })

  // ---------- 管理域: print_modes ----------

  app.get('/api/pricing/modes', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT * FROM print_modes ORDER BY id').all(),
  )

  const MODE_PROPS = {
    name: { type: 'string', minLength: 1 },
    printer_id: { type: 'integer', minimum: 1 },
    ink_type: { type: 'string', enum: ['toner', 'pigment', 'dye'] },
    pricing_mode: { type: 'string', enum: ['set', 'ml'] },
    ink_price_c: MONEY_C,
    ml_per_batch: { type: ['integer', 'null'], minimum: 1 },
    yield_sheets: { type: 'integer', minimum: 1 },
    ref_size: { type: 'string' },
    max_size: { type: 'string' },
    duplex: { type: 'boolean' },
    color_tag: { type: ['string', 'null'] },
  }

  app.post(
    '/api/pricing/modes',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'printer_id', 'ink_type', 'pricing_mode', 'ink_price_c', 'yield_sheets', 'ref_size', 'max_size'],
          additionalProperties: false,
          properties: MODE_PROPS,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        name: string
        printer_id: number
        ink_type: string
        pricing_mode: string
        ink_price_c: number
        ml_per_batch?: number | null
        yield_sheets: number
        ref_size: string
        max_size: string
        duplex?: boolean
        color_tag?: string | null
      }
      if (b.pricing_mode === 'ml' && b.ml_per_batch == null) {
        return reply.status(422).send({ error: 'ml_per_batch_required' })
      }
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO print_modes (name, printer_id, ink_type, pricing_mode, ink_price_c,
                                    ml_per_batch, yield_sheets, ref_size, max_size, duplex, color_tag)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          b.name,
          b.printer_id,
          b.ink_type,
          b.pricing_mode,
          b.ink_price_c,
          b.ml_per_batch ?? null,
          b.yield_sheets,
          b.ref_size,
          b.max_size,
          b.duplex ? 1 : 0,
          b.color_tag ?? null,
        )
      return reply
        .status(201)
        .send(db.prepare('SELECT * FROM print_modes WHERE id = ?').get(lastInsertRowid))
    },
  )

  app.patch(
    '/api/pricing/modes/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: ID_PARAM,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { ...MODE_PROPS, archived: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const existing = db.prepare('SELECT * FROM print_modes WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as Record<string, unknown>
      const merged = { ...existing, ...b }
      if (typeof b['duplex'] === 'boolean') merged['duplex'] = b['duplex'] ? 1 : 0
      if (typeof b['archived'] === 'boolean') merged['archived'] = b['archived'] ? 1 : 0
      if (merged['pricing_mode'] === 'ml' && merged['ml_per_batch'] == null) {
        return reply.status(422).send({ error: 'ml_per_batch_required' })
      }
      db.prepare(
        `UPDATE print_modes SET name=@name, printer_id=@printer_id, ink_type=@ink_type,
           pricing_mode=@pricing_mode, ink_price_c=@ink_price_c, ml_per_batch=@ml_per_batch,
           yield_sheets=@yield_sheets, ref_size=@ref_size, max_size=@max_size,
           duplex=@duplex, color_tag=@color_tag, archived=@archived
         WHERE id=@id`,
      ).run(merged)
      return db.prepare('SELECT * FROM print_modes WHERE id = ?').get(id)
    },
  )

  app.delete('/api/pricing/modes/:id', { preHandler: requireAdmin, schema: { params: ID_PARAM } }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { changes } = db.prepare('UPDATE print_modes SET archived = 1 WHERE id = ?').run(id)
    if (changes === 0) return reply.status(404).send({ error: 'not_found' })
    return reply.status(204).send()
  })

  // ---------- 管理域: papers + paper_size_costs ----------

  app.get('/api/pricing/papers', { preHandler: requireAdmin }, async () => {
    const papers = db.prepare('SELECT * FROM papers ORDER BY id').all() as Array<{ id: number }>
    const costs = db.prepare('SELECT * FROM paper_size_costs').all() as Array<{
      paper_id: number
      size_key: string
      pack_price_c: number
      pack_count: number
    }>
    return papers.map((p) => ({
      ...p,
      size_costs: costs.filter((c) => c.paper_id === p.id),
    }))
  })

  const PAPER_PROPS = {
    name: { type: 'string', minLength: 1 },
    category: { type: ['string', 'null'] },
    gsm: { type: ['integer', 'null'], minimum: 1 },
    color_tag: { type: ['string', 'null'] },
    supplier: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
  }

  app.post(
    '/api/pricing/papers',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: PAPER_PROPS,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as Record<string, unknown>
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO papers (name, category, gsm, color_tag, supplier, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(b['name'], b['category'] ?? null, b['gsm'] ?? null, b['color_tag'] ?? null, b['supplier'] ?? null, b['notes'] ?? null)
      return reply
        .status(201)
        .send(db.prepare('SELECT * FROM papers WHERE id = ?').get(lastInsertRowid))
    },
  )

  app.patch(
    '/api/pricing/papers/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: ID_PARAM,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { ...PAPER_PROPS, archived: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const existing = db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as Record<string, unknown>
      const merged = { ...existing, ...b }
      if (typeof b['archived'] === 'boolean') merged['archived'] = b['archived'] ? 1 : 0
      db.prepare(
        `UPDATE papers SET name=@name, category=@category, gsm=@gsm, color_tag=@color_tag,
           supplier=@supplier, notes=@notes, archived=@archived WHERE id=@id`,
      ).run(merged)
      return db.prepare('SELECT * FROM papers WHERE id = ?').get(id)
    },
  )

  app.delete('/api/pricing/papers/:id', { preHandler: requireAdmin, schema: { params: ID_PARAM } }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { changes } = db.prepare('UPDATE papers SET archived = 1 WHERE id = ?').run(id)
    if (changes === 0) return reply.status(404).send({ error: 'not_found' })
    return reply.status(204).send()
  })

  app.put(
    '/api/pricing/paper-size-costs',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['paper_id', 'size_key', 'pack_price_c', 'pack_count'],
          additionalProperties: false,
          properties: {
            paper_id: { type: 'integer', minimum: 1 },
            size_key: { type: 'string', minLength: 1 },
            pack_price_c: MONEY_C,
            pack_count: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        paper_id: number
        size_key: string
        pack_price_c: number
        pack_count: number
      }
      try {
        db.prepare(
          `INSERT INTO paper_size_costs (paper_id, size_key, pack_price_c, pack_count)
           VALUES (@paper_id, @size_key, @pack_price_c, @pack_count)
           ON CONFLICT(paper_id, size_key) DO UPDATE SET
             pack_price_c = excluded.pack_price_c, pack_count = excluded.pack_count`,
        ).run(b)
      } catch (err) {
        if (isConstraint(err, 'FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_paper_or_size' })
        }
        throw err
      }
      return db
        .prepare('SELECT * FROM paper_size_costs WHERE paper_id = ? AND size_key = ?')
        .get(b.paper_id, b.size_key)
    },
  )

  app.delete(
    '/api/pricing/paper-size-costs/:paperId/:sizeKey',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { paperId, sizeKey } = req.params as { paperId: string; sizeKey: string }
      const { changes } = db
        .prepare('DELETE FROM paper_size_costs WHERE paper_id = ? AND size_key = ?')
        .run(Number(paperId), sizeKey)
      if (changes === 0) return reply.status(404).send({ error: 'not_found' })
      return reply.status(204).send()
    },
  )

  // ---------- 管理域: combos + combo_prices ----------

  app.get('/api/pricing/combos', { preHandler: requireAdmin }, async () => {
    const combos = db.prepare('SELECT * FROM combos ORDER BY id').all() as Array<{ id: number }>
    const prices = db.prepare('SELECT * FROM combo_prices').all() as Array<{ combo_id: number }>
    return combos.map((c) => ({ ...c, prices: prices.filter((p) => p.combo_id === c.id) }))
  })

  app.post(
    '/api/pricing/combos',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['mode_id', 'paper_id'],
          additionalProperties: false,
          properties: {
            mode_id: { type: 'integer', minimum: 1 },
            paper_id: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { mode_id: number; paper_id: number }
      try {
        const { lastInsertRowid } = db
          .prepare('INSERT INTO combos (mode_id, paper_id) VALUES (?, ?)')
          .run(b.mode_id, b.paper_id)
        return await reply
          .status(201)
          .send(db.prepare('SELECT * FROM combos WHERE id = ?').get(lastInsertRowid))
      } catch (err) {
        if (isConstraint(err, 'UNIQUE')) return reply.status(409).send({ error: 'combo_exists' })
        if (isConstraint(err, 'FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_mode_or_paper' })
        }
        throw err
      }
    },
  )

  app.patch(
    '/api/pricing/combos/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: ID_PARAM,
        body: {
          type: 'object',
          required: ['archived'],
          additionalProperties: false,
          properties: { archived: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const { changes } = db
        .prepare('UPDATE combos SET archived = ? WHERE id = ?')
        .run((req.body as { archived: boolean }).archived ? 1 : 0, id)
      if (changes === 0) return reply.status(404).send({ error: 'not_found' })
      return db.prepare('SELECT * FROM combos WHERE id = ?').get(id)
    },
  )

  app.delete('/api/pricing/combos/:id', { preHandler: requireAdmin, schema: { params: ID_PARAM } }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { changes } = db.prepare('UPDATE combos SET archived = 1 WHERE id = ?').run(id)
    if (changes === 0) return reply.status(404).send({ error: 'not_found' })
    return reply.status(204).send()
  })

  app.put(
    '/api/pricing/combos/:id/prices/:sizeKey',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            sell_c: { type: ['integer', 'null'], minimum: 0 },
            internal_sell_c: { type: ['integer', 'null'], minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id, sizeKey } = req.params as { id: string; sizeKey: string }
      const comboId = Number(id)
      if (!db.prepare('SELECT 1 FROM combos WHERE id = ?').get(comboId)) {
        return reply.status(404).send({ error: 'not_found' })
      }
      const b = req.body as { sell_c?: number | null; internal_sell_c?: number | null }
      const existing = db
        .prepare('SELECT sell_c, internal_sell_c FROM combo_prices WHERE combo_id = ? AND size_key = ?')
        .get(comboId, sizeKey) as { sell_c: number | null; internal_sell_c: number | null } | undefined
      const sell = 'sell_c' in b ? (b.sell_c ?? null) : (existing?.sell_c ?? null)
      const internal =
        'internal_sell_c' in b ? (b.internal_sell_c ?? null) : (existing?.internal_sell_c ?? null)
      try {
        db.prepare(
          `INSERT INTO combo_prices (combo_id, size_key, sell_c, internal_sell_c)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(combo_id, size_key) DO UPDATE SET
             sell_c = excluded.sell_c, internal_sell_c = excluded.internal_sell_c`,
        ).run(comboId, sizeKey, sell, internal)
      } catch (err) {
        if (isConstraint(err, 'FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_size' })
        }
        throw err
      }
      return db
        .prepare('SELECT * FROM combo_prices WHERE combo_id = ? AND size_key = ?')
        .get(comboId, sizeKey)
    },
  )

  // ---------- 管理域: 成本速查 ----------

  app.get('/api/admin/pricing/quotes', { preHandler: requireAdmin }, async () => listQuotable(db))

  // ---------- 下单域: 计算器 ----------

  const PRICE_ENTRY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { sell_c: { type: 'integer' }, display: { type: 'string' } },
  }

  app.get(
    '/api/calculator/options',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              currency: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  code: { type: 'string' },
                  symbol: { type: 'string' },
                  decimal_places: { type: 'integer' },
                },
              },
              sizes: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    key: { type: 'string' },
                    label: { type: 'string' },
                    sort: { type: 'integer' },
                  },
                },
              },
              modes: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    duplex: { type: 'boolean' },
                    max_size: { type: 'string' },
                  },
                },
              },
              papers: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { id: { type: 'integer' }, name: { type: 'string' } },
                },
              },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mode_id: { type: 'integer' },
                    paper_id: { type: 'integer' },
                    prices: { type: 'object', additionalProperties: PRICE_ENTRY_SCHEMA },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const currency = baseCurrency(db)
      const internal = req.user?.role === 'member'
      const quotes = listQuotable(db, { internal })
      const grouped = new Map<string, { mode_id: number; paper_id: number; prices: Record<string, { sell_c: number; display: string }> }>()
      for (const q of quotes) {
        const key = `${q.mode_id}:${q.paper_id}`
        let entry = grouped.get(key)
        if (!entry) {
          entry = { mode_id: q.mode_id, paper_id: q.paper_id, prices: {} }
          grouped.set(key, entry)
        }
        entry.prices[q.size_key] = { sell_c: q.sell_c, display: formatMoneyC(q.sell_c, currency) }
      }
      return {
        currency,
        sizes: db.prepare('SELECT key, label, sort FROM sizes ORDER BY sort').all(),
        modes: (
          db
            .prepare('SELECT id, name, duplex, max_size FROM print_modes WHERE archived = 0 ORDER BY id')
            .all() as Array<{ id: number; name: string; duplex: number; max_size: string }>
        ).map((m) => ({ ...m, duplex: m.duplex !== 0 })),
        papers: db.prepare('SELECT id, name FROM papers WHERE archived = 0 ORDER BY id').all(),
        options: [...grouped.values()],
      }
    },
  )

  app.post(
    '/api/calculator/quote',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['mode_id', 'paper_id', 'size_key', 'quantity'],
          additionalProperties: false,
          properties: {
            mode_id: { type: 'integer', minimum: 1 },
            paper_id: { type: 'integer', minimum: 1 },
            size_key: { type: 'string', minLength: 1 },
            quantity: { type: 'integer', minimum: 1, maximum: 1000000 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode_id: { type: 'integer' },
              paper_id: { type: 'integer' },
              size_key: { type: 'string' },
              quantity: { type: 'integer' },
              unit_price_c: { type: 'integer' },
              unit_display: { type: 'string' },
              line_total: { type: 'integer' },
              line_total_display: { type: 'string' },
              currency: { type: 'string' },
            },
          },
          404: {
            type: 'object',
            additionalProperties: false,
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { mode_id: number; paper_id: number; size_key: string; quantity: number }
      const internal = req.user?.role === 'member'
      const q = quote(db, b.mode_id, b.paper_id, b.size_key, { internal })
      if (!q) return reply.status(404).send({ error: 'not_quotable' })
      const currency = baseCurrency(db)
      const total = lineTotal(q.sell_c, b.quantity)
      return {
        mode_id: b.mode_id,
        paper_id: b.paper_id,
        size_key: b.size_key,
        quantity: b.quantity,
        unit_price_c: q.sell_c,
        unit_display: formatMoneyC(q.sell_c, currency),
        line_total: total,
        line_total_display: formatMoney(total, currency),
        currency: currency.code,
      }
    },
  )
}
