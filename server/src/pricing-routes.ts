import { type FastifyInstance } from 'fastify'
import { audit } from './audit.js'
import { BookError, priceBook, priceBookSpec } from './books.js'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { finishingContribution, type FinishingPricing } from './finishing.js'
import { requireAdmin } from './guards.js'
import { formatMoney, formatMoneyC, lineTotal, moneyC } from './money.js'
import { invalidateQuotableCache, listProducts, listQuotable, quote } from './pricing.js'
import { sendXlsx } from './xlsx.js'

const MONEY_C = { type: 'integer', minimum: 0 }
const ID_PARAM = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^\\d+$' } },
}

import { isConstraint } from './errors.js'

export function registerPricingRoutes(app: FastifyInstance, db: DB): void {
  // PC1: 定价/配置编辑审计（单一 audit() 入口，best-effort 不阻断）
  const logEdit = (actorId: string | null, action: string, targetId: string | number, summary: string) =>
    audit(db, { actorId, action, targetType: 'pricing', targetId: String(targetId), summary })

  app.addHook('onResponse', (req, _reply, done) => {
    if (req.method !== 'GET' && (req.url.startsWith('/api/pricing/') || req.url.startsWith('/api/admin/pricing/'))) {
      invalidateQuotableCache()
    }
    done()
  })

  // ---------- 管理域: sizes ----------

  app.get('/api/pricing/sizes', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT key, label, area, sort, width_mm, height_mm FROM sizes ORDER BY sort').all(),
  )

  // D36 物理尺寸（mm）：供文件预检尺寸/出血匹配；可空（未配则预检跳过尺寸项）
  const MM = { type: ['integer', 'null'], minimum: 1 } as const

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
            width_mm: MM,
            height_mm: MM,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { key: string; label: string; area: number; sort?: number; width_mm?: number | null; height_mm?: number | null }
      try {
        db.prepare('INSERT INTO sizes (key, label, area, sort, width_mm, height_mm) VALUES (?, ?, ?, ?, ?, ?)').run(
          b.key,
          b.label,
          b.area,
          b.sort ?? 0,
          b.width_mm ?? null,
          b.height_mm ?? null,
        )
      } catch (err) {
        if (isConstraint(err, 'UNIQUE') || isConstraint(err, 'PRIMARY')) {
          return reply.status(409).send({ error: 'key_exists' })
        }
        throw err
      }
      logEdit(req.user?.id ?? null, 'pricing.size', b.key, `新建尺寸 ${b.key}`)
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
            width_mm: MM,
            height_mm: MM,
          },
        },
      },
    },
    async (req, reply) => {
      const { key } = req.params as { key: string }
      const existing = db.prepare('SELECT * FROM sizes WHERE key = ?').get(key) as
        | { label: string; area: number; sort: number; width_mm: number | null; height_mm: number | null }
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as Partial<{ label: string; area: number; sort: number; width_mm: number | null; height_mm: number | null }>
      db.prepare('UPDATE sizes SET label = ?, area = ?, sort = ?, width_mm = ?, height_mm = ? WHERE key = ?').run(
        b.label ?? existing.label,
        b.area ?? existing.area,
        b.sort ?? existing.sort,
        'width_mm' in b ? (b.width_mm ?? null) : existing.width_mm,
        'height_mm' in b ? (b.height_mm ?? null) : existing.height_mm,
        key,
      )
      logEdit(req.user?.id ?? null, 'pricing.size', key, `改尺寸 ${key}`)
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
    logEdit(req.user?.id ?? null, 'pricing.size', key, `删尺寸 ${key}`)
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
    color_class: { type: ['string', 'null'] }, // D25: 结构化色彩档（单页属性配置器筛选用）
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
        color_class?: string | null
      }
      if (b.pricing_mode === 'ml' && b.ml_per_batch == null) {
        return reply.status(422).send({ error: 'ml_per_batch_required' })
      }
      let lastInsertRowid: number | bigint
      try {
        ;({ lastInsertRowid } = db
          .prepare(
            `INSERT INTO print_modes (name, printer_id, ink_type, pricing_mode, ink_price_c,
                                      ml_per_batch, yield_sheets, ref_size, max_size, duplex, color_tag, color_class)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            b.color_class ?? null,
          ))
      } catch (err) {
        if (isConstraint(err, 'FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_printer_or_size' })
        }
        throw err
      }
      logEdit(req.user?.id ?? null, 'pricing.mode', String(lastInsertRowid), `新建模式 ${b.name}`)
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
      try {
        db.prepare(
          `UPDATE print_modes SET name=@name, printer_id=@printer_id, ink_type=@ink_type,
             pricing_mode=@pricing_mode, ink_price_c=@ink_price_c, ml_per_batch=@ml_per_batch,
             yield_sheets=@yield_sheets, ref_size=@ref_size, max_size=@max_size,
             duplex=@duplex, color_tag=@color_tag, color_class=@color_class, archived=@archived
           WHERE id=@id`,
        ).run(merged)
      } catch (err) {
        if (isConstraint(err, 'FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_printer_or_size' })
        }
        throw err
      }
      logEdit(req.user?.id ?? null, 'pricing.mode', id, `改模式 ${id}`)
      return db.prepare('SELECT * FROM print_modes WHERE id = ?').get(id)
    },
  )

  app.delete('/api/pricing/modes/:id', { preHandler: requireAdmin, schema: { params: ID_PARAM } }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { changes } = db.prepare('UPDATE print_modes SET archived = 1 WHERE id = ?').run(id)
    if (changes === 0) return reply.status(404).send({ error: 'not_found' })
    logEdit(req.user?.id ?? null, 'pricing.mode', id, `归档模式 ${id}`)
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
    const costMap = new Map<number, typeof costs>()
    for (const c of costs) {
      const arr = costMap.get(c.paper_id)
      if (arr) arr.push(c)
      else costMap.set(c.paper_id, [c])
    }
    return papers.map((p) => ({
      ...p,
      size_costs: costMap.get(p.id) ?? [],
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
      logEdit(req.user?.id ?? null, 'pricing.paper', String(lastInsertRowid), `新建纸张 ${String(b['name'])}`)
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
      logEdit(req.user?.id ?? null, 'pricing.paper', id, `改纸张 ${id}`)
      return db.prepare('SELECT * FROM papers WHERE id = ?').get(id)
    },
  )

  app.delete('/api/pricing/papers/:id', { preHandler: requireAdmin, schema: { params: ID_PARAM } }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { changes } = db.prepare('UPDATE papers SET archived = 1 WHERE id = ?').run(id)
    if (changes === 0) return reply.status(404).send({ error: 'not_found' })
    logEdit(req.user?.id ?? null, 'pricing.paper', id, `归档纸张 ${id}`)
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
    const prices = db.prepare('SELECT * FROM combo_prices').all() as Array<{
      combo_id: number
      size_key: string
    }>
    const tiers = db.prepare('SELECT * FROM combo_price_tiers ORDER BY min_qty').all() as Array<{
      combo_id: number
      size_key: string
      min_qty: number
      sell_c: number
      internal_sell_c: number | null
    }>
    const tierMap = new Map<string, typeof tiers>()
    for (const t of tiers) {
      const key = `${t.combo_id}:${t.size_key}`
      const arr = tierMap.get(key)
      if (arr) arr.push(t)
      else tierMap.set(key, [t])
    }
    const priceMap = new Map<number, Array<Record<string, unknown>>>()
    for (const p of prices) {
      const key = `${p.combo_id}:${p.size_key}`
      const row = { ...p, tiers: tierMap.get(key) ?? [] }
      const arr = priceMap.get(p.combo_id)
      if (arr) arr.push(row)
      else priceMap.set(p.combo_id, [row])
    }
    return combos.map((c) => ({ ...c, prices: priceMap.get(c.id) ?? [] }))
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

  const TIER_SCHEMA = {
    type: 'object',
    required: ['min_qty', 'sell_c'],
    additionalProperties: false,
    properties: {
      min_qty: { type: 'integer', minimum: 2 },
      sell_c: { type: 'integer', minimum: 0 },
      internal_sell_c: { type: ['integer', 'null'], minimum: 0 },
    },
  }

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
            tiers: { type: 'array', items: TIER_SCHEMA },
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
      const b = req.body as {
        sell_c?: number | null
        internal_sell_c?: number | null
        tiers?: Array<{ min_qty: number; sell_c: number; internal_sell_c?: number | null }>
      }
      const existing = db
        .prepare('SELECT sell_c, internal_sell_c FROM combo_prices WHERE combo_id = ? AND size_key = ?')
        .get(comboId, sizeKey) as { sell_c: number | null; internal_sell_c: number | null } | undefined
      const sell = 'sell_c' in b ? (b.sell_c ?? null) : (existing?.sell_c ?? null)
      const internal =
        'internal_sell_c' in b ? (b.internal_sell_c ?? null) : (existing?.internal_sell_c ?? null)
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO combo_prices (combo_id, size_key, sell_c, internal_sell_c)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(combo_id, size_key) DO UPDATE SET
               sell_c = excluded.sell_c, internal_sell_c = excluded.internal_sell_c`,
          ).run(comboId, sizeKey, sell, internal)
          if (b.tiers !== undefined) {
            db.prepare('DELETE FROM combo_price_tiers WHERE combo_id = ? AND size_key = ?').run(comboId, sizeKey)
            const ins = db.prepare(
              'INSERT INTO combo_price_tiers (combo_id, size_key, min_qty, sell_c, internal_sell_c) VALUES (?, ?, ?, ?, ?)',
            )
            for (const t of b.tiers) {
              ins.run(comboId, sizeKey, t.min_qty, t.sell_c, t.internal_sell_c ?? null)
            }
          }
        })()
      } catch (err) {
        if (isConstraint(err, 'FOREIGN KEY')) {
          return reply.status(409).send({ error: 'unknown_size' })
        }
        throw err
      }
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'pricing.combo_price',
        targetType: 'combo',
        targetId: String(comboId),
        summary: `combo ${comboId} ${sizeKey}: sell_c=${sell ?? 'auto'} internal=${internal ?? 'auto'}${b.tiers ? ` tiers=${b.tiers.length}` : ''}`,
      })
      return db
        .prepare('SELECT * FROM combo_prices WHERE combo_id = ? AND size_key = ?')
        .get(comboId, sizeKey)
    },
  )

  // 工艺库 CRUD
  app.get('/api/pricing/finishings', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT * FROM finishing_ops ORDER BY id').all(),
  )

  const FINISHING_PROPS = {
    name: { type: 'string', minLength: 1 },
    pricing: { type: 'string', enum: ['per_book', 'per_page', 'per_area'] },
    price_c: MONEY_C,
    category: { type: ['string', 'null'] },
  }

  app.post(
    '/api/pricing/finishings',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'pricing', 'price_c'],
          additionalProperties: false,
          properties: FINISHING_PROPS,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { name: string; pricing: string; price_c: number; category?: string | null }
      const { lastInsertRowid } = db
        .prepare('INSERT INTO finishing_ops (name, pricing, price_c, category) VALUES (?, ?, ?, ?)')
        .run(b.name, b.pricing, b.price_c, b.category ?? null)
      logEdit(req.user?.id ?? null, 'pricing.finishing', String(lastInsertRowid), `新建工艺 ${b.name} ${b.pricing} ${b.price_c}`)
      return reply.status(201).send(db.prepare('SELECT * FROM finishing_ops WHERE id = ?').get(lastInsertRowid))
    },
  )

  app.patch(
    '/api/pricing/finishings/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: ID_PARAM,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { ...FINISHING_PROPS, archived: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const existing = db.prepare('SELECT * FROM finishing_ops WHERE id = ?').get(id) as
        | { name: string; pricing: string; price_c: number; archived: number; category: string | null }
        | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      const b = req.body as { name?: string; pricing?: string; price_c?: number; archived?: boolean; category?: string | null }
      db.prepare('UPDATE finishing_ops SET name = ?, pricing = ?, price_c = ?, archived = ?, category = ? WHERE id = ?').run(
        b.name ?? existing.name,
        b.pricing ?? existing.pricing,
        b.price_c ?? existing.price_c,
        b.archived === undefined ? existing.archived : b.archived ? 1 : 0,
        b.category === undefined ? existing.category : b.category,
        id,
      )
      logEdit(req.user?.id ?? null, 'pricing.finishing', id, `改工艺 ${id}`)
      return db.prepare('SELECT * FROM finishing_ops WHERE id = ?').get(id)
    },
  )

  app.delete('/api/pricing/finishings/:id', { preHandler: requireAdmin, schema: { params: ID_PARAM } }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { changes } = db.prepare('UPDATE finishing_ops SET archived = 1 WHERE id = ?').run(id)
    if (changes === 0) return reply.status(404).send({ error: 'not_found' })
    logEdit(req.user?.id ?? null, 'pricing.finishing', id, `归档工艺 ${id}`)
    return reply.status(204).send()
  })

  // ---------- 管理域: 成本速查 ----------

  app.get('/api/admin/pricing/quotes', { preHandler: requireAdmin }, async () => {
    const currency = baseCurrency(db)
    const tierKeys = new Set(
      (db.prepare('SELECT DISTINCT combo_id, size_key FROM combo_price_tiers').all() as Array<{
        combo_id: number
        size_key: string
      }>).map((t) => `${t.combo_id}:${t.size_key}`),
    )
    const combos = new Map(
      (db.prepare('SELECT id, mode_id, paper_id FROM combos').all() as Array<{
        id: number
        mode_id: number
        paper_id: number
      }>).map((c) => [`${c.mode_id}:${c.paper_id}`, c.id]),
    )
    return listQuotable(db).map((q) => {
      const comboId = combos.get(`${q.mode_id}:${q.paper_id}`)
      return {
        ...q,
        ink_display: formatMoneyC(q.ink_c, currency),
        paper_display: formatMoneyC(q.paper_c, currency),
        total_display: formatMoneyC(q.total_c, currency),
        auto_display: formatMoneyC(q.auto_sell_c, currency),
        sell_display: formatMoneyC(q.sell_c, currency),
        has_tiers: comboId != null && tierKeys.has(`${comboId}:${q.size_key}`),
      }
    })
  })

  app.get('/api/admin/pricing/export', { preHandler: requireAdmin }, async (_req, reply) => {
    const currency = baseCurrency(db)
    const quotes = listQuotable(db)
    const modes = new Map(
      (db.prepare('SELECT id, name FROM print_modes').all() as Array<{ id: number; name: string }>).map((m) => [m.id, m.name]),
    )
    const papers = new Map(
      (db.prepare('SELECT id, name FROM papers').all() as Array<{ id: number; name: string }>).map((p) => [p.id, p.name]),
    )
    const sizes = new Map(
      (db.prepare('SELECT key, label FROM sizes').all() as Array<{ key: string; label: string }>).map((s) => [s.key, s.label]),
    )
    return sendXlsx(reply, 'pricing.xlsx', [
      {
        name: '价目表',
        columns: [
          { header: '打印模式', key: 'mode_name', width: 20 },
          { header: '纸张', key: 'paper_name', width: 18 },
          { header: '尺寸', key: 'size_label', width: 10 },
          { header: '墨耗成本', key: 'ink_display', width: 12 },
          { header: '纸张成本', key: 'paper_display', width: 12 },
          { header: '总成本', key: 'total_display', width: 12 },
          { header: '自动地板价', key: 'auto_display', width: 14 },
          { header: '售价', key: 'sell_display', width: 12 },
          { header: '手动价_c', key: 'sell_c', width: 12 },
          { header: '来源', key: 'source', width: 8 },
          { header: '标记', key: 'flag', width: 14 },
        ],
        rows: quotes.map((q) => ({
          mode_name: modes.get(q.mode_id) ?? String(q.mode_id),
          paper_name: papers.get(q.paper_id) ?? String(q.paper_id),
          size_label: sizes.get(q.size_key) ?? q.size_key,
          ink_display: formatMoneyC(q.ink_c, currency),
          paper_display: formatMoneyC(q.paper_c, currency),
          total_display: formatMoneyC(q.total_c, currency),
          auto_display: formatMoneyC(q.auto_sell_c, currency),
          sell_display: formatMoneyC(q.sell_c, currency),
          sell_c: q.source === 'manual' ? q.sell_c : null,
          source: q.source,
          flag: q.flag,
        })),
      },
    ])
  })

  app.post('/api/admin/pricing/import', { preHandler: requireAdmin }, async (req, reply) => {
    const file = await req.file()
    if (!file) return reply.status(400).send({ error: 'no_file' })
    const ext = file.filename.split('.').pop()?.toLowerCase()
    if (ext !== 'xlsx') return reply.status(400).send({ error: 'xlsx_only' })

    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.read(file.file)
    const ws = wb.worksheets[0]
    if (!ws) return reply.status(400).send({ error: 'empty_workbook' })

    const headers: string[] = []
    ws.getRow(1).eachCell((cell, col) => {
      headers[col] = String(cell.value ?? '').trim()
    })
    const colMode = headers.indexOf('打印模式')
    const colPaper = headers.indexOf('纸张')
    const colSize = headers.indexOf('尺寸')
    const colSellC = headers.indexOf('手动价_c')
    if (colMode < 0 || colPaper < 0 || colSize < 0 || colSellC < 0) {
      return reply.status(422).send({
        error: 'missing_columns',
        message: '需要列：打印模式, 纸张, 尺寸, 手动价_c',
      })
    }

    const modes = new Map(
      (db.prepare('SELECT id, name FROM print_modes WHERE archived = 0').all() as Array<{ id: number; name: string }>).map(
        (m) => [m.name, m.id],
      ),
    )
    const papers = new Map(
      (db.prepare('SELECT id, name FROM papers WHERE archived = 0').all() as Array<{ id: number; name: string }>).map(
        (p) => [p.name, p.id],
      ),
    )
    const sizes = new Map(
      (db.prepare('SELECT key, label FROM sizes').all() as Array<{ key: string; label: string }>).map(
        (s) => [s.label, s.key],
      ),
    )
    const combos = new Map(
      (
        db.prepare('SELECT id, mode_id, paper_id FROM combos WHERE archived = 0').all() as Array<{
          id: number
          mode_id: number
          paper_id: number
        }>
      ).map((c) => [`${c.mode_id}:${c.paper_id}`, c.id]),
    )

    const upsert = db.prepare(
      `INSERT INTO combo_prices (combo_id, size_key, sell_c, internal_sell_c)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(combo_id, size_key) DO UPDATE SET sell_c = excluded.sell_c`,
    )
    const delPrice = db.prepare(
      `DELETE FROM combo_prices WHERE combo_id = ? AND size_key = ?`,
    )

    let updated = 0
    const skipped: Array<{ row: number; reason: string }> = []

    const txn = db.transaction(() => {
      ws.eachRow((row, rowNum) => {
        if (rowNum <= 1) return
        const modeName = String(row.getCell(colMode).value ?? '').trim()
        const paperName = String(row.getCell(colPaper).value ?? '').trim()
        const sizeLabel = String(row.getCell(colSize).value ?? '').trim()
        const rawSellC = row.getCell(colSellC).value

        if (!modeName || !paperName || !sizeLabel) {
          skipped.push({ row: rowNum, reason: '名称列为空' })
          return
        }

        const modeId = modes.get(modeName)
        if (modeId == null) {
          skipped.push({ row: rowNum, reason: `未知打印模式: ${modeName}` })
          return
        }
        const paperId = papers.get(paperName)
        if (paperId == null) {
          skipped.push({ row: rowNum, reason: `未知纸张: ${paperName}` })
          return
        }
        const sizeKey = sizes.get(sizeLabel) ?? sizeLabel
        const comboId = combos.get(`${modeId}:${paperId}`)
        if (comboId == null) {
          skipped.push({ row: rowNum, reason: `组合不存在: ${modeName} × ${paperName}` })
          return
        }

        if (rawSellC == null || rawSellC === '' || rawSellC === null) {
          delPrice.run(comboId, sizeKey)
          updated++
          return
        }

        const sellC = Math.trunc(Number(rawSellC))
        if (!Number.isSafeInteger(sellC) || sellC < 0) {
          skipped.push({ row: rowNum, reason: `手动价_c 不是非负整数: ${String(rawSellC)}` })
          return
        }

        upsert.run(comboId, sizeKey, sellC)
        updated++
      })
    })
    txn()

    return { updated, skipped }
  })

  // ---------- 下单域: 计算器 ----------

  const PRICE_ENTRY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { sell_c: { type: 'integer' }, display: { type: 'string' } },
  }

  app.get(
    '/api/calculator/options',
    {
      // 公开端点：每次重算全目录报价矩阵，须限流防刮取/打满
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
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

  // ③⑤ 客户产品视图：按属性折叠的目录（机器对客户不可见，仅 sell 侧字段，下单域可读）
  app.get(
    '/api/calculator/products',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
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
              papers: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' }, name: { type: 'string' } } } },
              sizes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, label: { type: 'string' }, sort: { type: 'integer' } } } },
              products: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    category: { type: 'string' },
                    tech: { type: 'string' },
                    paper_id: { type: 'integer' },
                    size_key: { type: 'string' },
                    duplex: { type: 'boolean' },
                    mode_id: { type: 'integer' },
                    sell_c: { type: 'integer' },
                    display: { type: 'string' },
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
      const products = listProducts(db, { internal }).map((p) => ({
        category: p.category,
        tech: p.tech,
        paper_id: p.paper_id,
        size_key: p.size_key,
        duplex: p.duplex !== 0,
        mode_id: p.mode_id,
        sell_c: p.sell_c as number,
        display: formatMoneyC(p.sell_c, currency),
      }))
      return {
        currency,
        papers: db.prepare('SELECT id, name FROM papers WHERE archived = 0 ORDER BY id').all(),
        sizes: db.prepare('SELECT key, label, sort FROM sizes ORDER BY sort').all(),
        products,
      }
    },
  )

  // ③⑤/D27 下单域: 书册目录（机器对客户不可见，组件含纸/尺寸/色彩档/单双面 + 工艺）
  app.get(
    '/api/calculator/books',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => {
      const currency = baseCurrency(db)
      const books = db.prepare('SELECT id, name FROM book_products WHERE archived = 0 ORDER BY id').all() as Array<{
        id: number
        name: string
      }>
      const comps = db
        .prepare(
          `SELECT obc.id, obc.book_id, obc.role, obc.paper_id, p.name AS paper_name,
                  obc.size_key, s.label AS size_label, obc.color_class, obc.duplex, obc.sort
           FROM book_components obc
           JOIN papers p ON p.id = obc.paper_id
           JOIN sizes s ON s.key = obc.size_key
           WHERE obc.archived = 0
           ORDER BY obc.book_id, obc.sort, obc.id`,
        )
        .all() as Array<{ book_id: number; duplex: number } & Record<string, unknown>>
      const fins = db
        .prepare(
          `SELECT bf.book_id, f.id, f.name, f.pricing, f.price_c
           FROM book_finishings bf JOIN finishing_ops f ON f.id = bf.finishing_id
           WHERE f.archived = 0
           ORDER BY bf.book_id, f.id`,
        )
        .all() as Array<{ book_id: number; id: number; name: string; pricing: string; price_c: number }>
      return {
        currency,
        books: books.map((b) => ({
          id: b.id,
          name: b.name,
          components: comps
            .filter((c) => c.book_id === b.id)
            .map((c) => ({
              id: c['id'],
              role: c['role'],
              paper_id: c['paper_id'],
              paper_name: c['paper_name'],
              size_key: c['size_key'],
              size_label: c['size_label'],
              color_class: c['color_class'],
              duplex: c.duplex !== 0,
            })),
          finishings: fins
            .filter((f) => f.book_id === b.id)
            .map((f) => ({
              id: f.id,
              name: f.name,
              pricing: f.pricing,
              price_c: f.price_c,
              price_display: formatMoneyC(moneyC(f.price_c), currency),
            })),
        })),
      }
    },
  )

  // ③⑤/D27 下单域: 书册实时报价（客户填内页/插图张数 + 本数 → 出价；机器不可见，仅售价侧）
  app.post(
    '/api/calculator/book-quote',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['book_id', 'count'],
          additionalProperties: false,
          properties: {
            book_id: { type: 'integer', minimum: 1 },
            count: { type: 'integer', minimum: 1, maximum: 1000000 },
            components: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                required: ['component_id', 'sheets_per_book'],
                additionalProperties: false,
                properties: {
                  component_id: { type: 'integer', minimum: 1 },
                  sheets_per_book: { type: 'integer', minimum: 1, maximum: 1000000 },
                },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              book_id: { type: 'integer' },
              name: { type: 'string' },
              count: { type: 'integer' },
              unit_price_c: { type: 'integer' },
              unit_display: { type: 'string' },
              line_total: { type: 'integer' },
              line_total_display: { type: 'string' },
              components: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    component_id: { type: 'integer' },
                    role: { type: 'string' },
                    sheets_per_book: { type: 'integer' },
                    unit_sell_c: { type: 'integer' },
                    unit_display: { type: 'string' },
                  },
                },
              },
              finishings: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    finishing_id: { type: 'integer' },
                    name: { type: 'string' },
                    pricing: { type: 'string' },
                    contribution_c: { type: 'integer' },
                    contribution_display: { type: 'string' },
                  },
                },
              },
            },
          },
          422: {
            type: 'object',
            additionalProperties: false,
            properties: { error: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        book_id: number
        count: number
        components?: Array<{ component_id: number; sheets_per_book: number }>
      }
      const internal = req.user?.role === 'member'
      const sheets = Object.fromEntries((b.components ?? []).map((c) => [c.component_id, c.sheets_per_book]))
      let bq
      try {
        bq = priceBook(db, { book_id: b.book_id, count: b.count, sheets }, { internal })
      } catch (err) {
        // priceBook 仅抛 422（不可报价 / 缺张数 / 成品不存在）
        if (err instanceof BookError) return reply.status(422).send({ error: err.message })
        throw err
      }
      const currency = baseCurrency(db)
      const total = lineTotal(bq.unit_price_c, b.count)
      return {
        book_id: bq.book_id,
        name: bq.name,
        count: b.count,
        unit_price_c: bq.unit_price_c as number,
        unit_display: formatMoneyC(bq.unit_price_c, currency),
        line_total: total as number,
        line_total_display: formatMoney(total, currency),
        components: bq.components.map((c) => ({
          component_id: c.component_id,
          role: c.role,
          sheets_per_book: c.sheets_per_book,
          unit_sell_c: c.unit_sell_c as number,
          unit_display: formatMoneyC(c.unit_sell_c, currency),
        })),
        finishings: bq.finishings.map((f) => ({
          finishing_id: f.finishing_id,
          name: f.name,
          pricing: f.pricing,
          contribution_c: f.contribution_c as number,
          contribution_display: formatMoneyC(f.contribution_c, currency),
        })),
      }
    },
  )

  // 下单域: 工艺目录（客户自选单张工艺——排除 binding 类，装订仅书册用）
  app.get(
    '/api/calculator/finishings',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => {
      const currency = baseCurrency(db)
      const fins = db
        .prepare("SELECT id, name, pricing, price_c, category FROM finishing_ops WHERE archived = 0 AND (category IS NULL OR category != 'binding') ORDER BY id")
        .all() as Array<{ id: number; name: string; pricing: string; price_c: number; category: string | null }>
      return {
        currency,
        finishings: fins.map((f) => ({
          id: f.id,
          name: f.name,
          pricing: f.pricing,
          price_c: f.price_c,
          category: f.category,
          price_display: formatMoneyC(moneyC(f.price_c), currency),
        })),
      }
    },
  )

  // D36 下单域: 书册配置菜单（纸张×尺寸可用性 + 分组工艺目录）
  app.get(
    '/api/calculator/book-config',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const internal = req.user?.role === 'member'
      const currency = baseCurrency(db)
      const sizes = db.prepare('SELECT key, label, area, sort, width_mm, height_mm FROM sizes ORDER BY sort').all() as Array<{
        key: string; label: string; area: number; sort: number; width_mm: number | null; height_mm: number | null
      }>
      const papers = db.prepare('SELECT id, name, category, gsm FROM papers WHERE archived = 0 ORDER BY id').all() as Array<{
        id: number; name: string; category: string | null; gsm: number | null
      }>
      const psc = db.prepare('SELECT paper_id, size_key FROM paper_size_costs').all() as Array<{
        paper_id: number; size_key: string
      }>
      const paperSizes = new Map<number, string[]>()
      for (const row of psc) {
        const arr = paperSizes.get(row.paper_id)
        if (arr) arr.push(row.size_key)
        else paperSizes.set(row.paper_id, [row.size_key])
      }
      const products = listProducts(db, { internal })
      const paperColors = new Map<string, Set<string>>()
      for (const p of products) {
        const key = `${p.paper_id}:${p.size_key}`
        const set = paperColors.get(key)
        if (set) set.add(p.category)
        else paperColors.set(key, new Set([p.category]))
      }

      const fins = db
        .prepare('SELECT id, name, pricing, price_c, category FROM finishing_ops WHERE archived = 0 ORDER BY id')
        .all() as Array<{ id: number; name: string; pricing: string; price_c: number; category: string | null }>
      const binding = fins.filter((f) => f.category === 'binding')
      const addons = fins.filter((f) => f.category !== 'binding')

      return {
        currency,
        sizes,
        papers: papers.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          gsm: p.gsm,
          available_sizes: paperSizes.get(p.id) ?? [],
          color_classes: [...new Set(
            (paperSizes.get(p.id) ?? []).flatMap((sk) => [...(paperColors.get(`${p.id}:${sk}`) ?? [])]),
          )],
        })),
        finishings: {
          binding: binding.map((f) => ({
            id: f.id, name: f.name, pricing: f.pricing, price_c: f.price_c,
            price_display: formatMoneyC(moneyC(f.price_c), currency),
          })),
          addons: addons.map((f) => ({
            id: f.id, name: f.name, pricing: f.pricing, price_c: f.price_c, category: f.category,
            price_display: formatMoneyC(moneyC(f.price_c), currency),
          })),
        },
      }
    },
  )

  // D36 下单域: 自定义书册实时报价
  app.post(
    '/api/calculator/book-spec-quote',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['count', 'size_key', 'components'],
          additionalProperties: false,
          properties: {
            count: { type: 'integer', minimum: 1, maximum: 1000000 },
            size_key: { type: 'string', minLength: 1 },
            components: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                required: ['role', 'paper_id', 'color_class', 'duplex'],
                additionalProperties: false,
                properties: {
                  role: { type: 'string', enum: ['cover', 'inner', 'insert'] },
                  paper_id: { type: 'integer', minimum: 1 },
                  color_class: { type: 'string', minLength: 1 },
                  duplex: { type: 'integer', enum: [0, 1] },
                  sheets_per_book: { type: 'integer', minimum: 1, maximum: 1000000 },
                },
              },
            },
            finishing_ids: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1 } },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        count: number
        size_key: string
        components: Array<{ role: 'cover' | 'inner' | 'insert'; paper_id: number; color_class: string; duplex: number; sheets_per_book?: number }>
        finishing_ids?: number[]
      }
      const internal = req.user?.role === 'member'
      let bq
      try {
        bq = priceBookSpec(db, { ...b, finishing_ids: b.finishing_ids ?? [] }, { internal })
      } catch (err) {
        if (err instanceof BookError) return reply.status(422).send({ error: err.message })
        throw err
      }
      const currency = baseCurrency(db)
      const total = lineTotal(bq.unit_price_c, b.count)
      return {
        book_id: bq.book_id,
        name: bq.name,
        count: b.count,
        unit_price_c: bq.unit_price_c as number,
        unit_display: formatMoneyC(bq.unit_price_c, currency),
        line_total: total as number,
        line_total_display: formatMoney(total, currency),
        components: bq.components.map((c) => ({
          component_id: c.component_id,
          role: c.role,
          sheets_per_book: c.sheets_per_book,
          unit_sell_c: c.unit_sell_c as number,
          unit_display: formatMoneyC(c.unit_sell_c, currency),
        })),
        finishings: bq.finishings.map((f) => ({
          finishing_id: f.finishing_id,
          name: f.name,
          pricing: f.pricing,
          contribution_c: f.contribution_c as number,
          contribution_display: formatMoneyC(f.contribution_c, currency),
        })),
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
            finishing_ids: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1 } },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        mode_id: number; paper_id: number; size_key: string; quantity: number
        finishing_ids?: number[]
      }
      const internal = req.user?.role === 'member'
      const q = quote(db, b.mode_id, b.paper_id, b.size_key, { internal })
      if (!q) return reply.status(404).send({ error: 'not_quotable' })
      const currency = baseCurrency(db)

      let unitC = q.sell_c as number
      const finishingsOut: Array<{
        finishing_id: number; name: string; pricing: string
        price_c: number; contribution_c: number; contribution_display: string
      }> = []

      if (b.finishing_ids && b.finishing_ids.length > 0) {
        const mode = db.prepare('SELECT duplex, ref_size FROM print_modes WHERE id = ?').get(b.mode_id) as
          { duplex: number; ref_size: string } | undefined
        const size = db.prepare('SELECT area FROM sizes WHERE key = ?').get(b.size_key) as
          { area: number } | undefined
        if (mode && size) {
          const pages = mode.duplex ? 2 : 1
          const area = size.area
          const fins = db
            .prepare(
              `SELECT id, name, pricing, price_c FROM finishing_ops
               WHERE id IN (${b.finishing_ids.map(() => '?').join(',')}) AND archived = 0`,
            )
            .all(...b.finishing_ids) as Array<{ id: number; name: string; pricing: FinishingPricing; price_c: number }>
          for (const f of fins) {
            const c = finishingContribution(f, { pages, area }) as number
            unitC += c
            finishingsOut.push({
              finishing_id: f.id, name: f.name, pricing: f.pricing,
              price_c: f.price_c, contribution_c: c,
              contribution_display: formatMoneyC(moneyC(c), currency),
            })
          }
        }
      }

      const sellC = moneyC(unitC)
      const total = lineTotal(sellC, b.quantity)
      return {
        mode_id: b.mode_id,
        paper_id: b.paper_id,
        size_key: b.size_key,
        quantity: b.quantity,
        base_unit_price_c: q.sell_c as number,
        base_unit_display: formatMoneyC(q.sell_c, currency),
        unit_price_c: unitC,
        unit_display: formatMoneyC(sellC, currency),
        line_total: total,
        line_total_display: formatMoney(total, currency),
        currency: currency.code,
        finishings: finishingsOut,
      }
    },
  )
}
