import { type FastifyInstance } from 'fastify'
import { audit } from './audit.js'
import { type DB } from './db.js'
import { requireAdmin, requireUser } from './guards.js'
import {
  checkAutoUpgrade,
  computeDimension,
  getEffectiveTier,
  getUserMemberships,
  type CriterionRow,
  type TierRow,
} from './membership.js'

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { error: { type: 'string' } },
}

const TIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    track: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    sort: { type: 'integer' },
    discount_bp: { type: 'integer' },
    auto_upgrade: { type: 'boolean' },
    color_tag: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    archived: { type: 'boolean' },
    created_at: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          tier_id: { type: 'integer' },
          dimension: { type: 'string' },
          op: { type: 'string' },
          threshold: { type: 'integer' },
        },
      },
    },
  },
}

function tierDto(t: TierRow, criteria: CriterionRow[]) {
  return {
    ...t,
    auto_upgrade: t.auto_upgrade !== 0,
    archived: t.archived !== 0,
    criteria,
  }
}

export function registerMembershipRoutes(app: FastifyInstance, db: DB): void {
  // ---------- Admin: tier CRUD ----------

  app.get(
    '/api/admin/membership/tiers',
    {
      preHandler: requireAdmin,
      schema: { response: { 200: { type: 'array', items: TIER_SCHEMA } } },
    },
    async () => {
      const tiers = db.prepare('SELECT * FROM membership_tiers ORDER BY track, sort DESC').all() as TierRow[]
      const allCriteria = db.prepare('SELECT * FROM tier_criteria').all() as CriterionRow[]
      const criteriaMap = new Map<number, CriterionRow[]>()
      for (const c of allCriteria) {
        let arr = criteriaMap.get(c.tier_id)
        if (!arr) {
          arr = []
          criteriaMap.set(c.tier_id, arr)
        }
        arr.push(c)
      }
      return tiers.map((t) => tierDto(t, criteriaMap.get(t.id) ?? []))
    },
  )

  app.post(
    '/api/admin/membership/tiers',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['code', 'name'],
          additionalProperties: false,
          properties: {
            track: { type: 'string', minLength: 1, maxLength: 50 },
            code: { type: 'string', minLength: 1, maxLength: 30 },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            sort: { type: 'integer' },
            discount_bp: { type: 'integer', minimum: 0, maximum: 10000 },
            auto_upgrade: { type: 'boolean' },
            color_tag: { type: ['string', 'null'], maxLength: 30 },
            description: { type: ['string', 'null'], maxLength: 500 },
          },
        },
        response: { 201: TIER_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        track?: string
        code: string
        name: string
        sort?: number
        discount_bp?: number
        auto_upgrade?: boolean
        color_tag?: string | null
        description?: string | null
      }
      const now = new Date().toISOString()
      try {
        const info = db.prepare(
          `INSERT INTO membership_tiers (track, code, name, sort, discount_bp, auto_upgrade, color_tag, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          b.track ?? 'default',
          b.code,
          b.name,
          b.sort ?? 0,
          b.discount_bp ?? 0,
          b.auto_upgrade ? 1 : 0,
          b.color_tag ?? null,
          b.description ?? null,
          now,
        )
        const tier = db.prepare('SELECT * FROM membership_tiers WHERE id = ?').get(info.lastInsertRowid) as TierRow
        audit(db, {
          actorId: req.user?.id ?? null,
          action: 'membership.tier.create',
          targetType: 'membership_tier',
          targetId: String(tier.id),
          summary: `创建等级 ${tier.code} · ${tier.name}`,
        })
        return reply.status(201).send(tierDto(tier, []))
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          return reply.status(409).send({ error: 'code_exists' })
        }
        throw err
      }
    },
  )

  app.patch(
    '/api/admin/membership/tiers/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            track: { type: 'string', minLength: 1, maxLength: 50 },
            code: { type: 'string', minLength: 1, maxLength: 30 },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            sort: { type: 'integer' },
            discount_bp: { type: 'integer', minimum: 0, maximum: 10000 },
            auto_upgrade: { type: 'boolean' },
            color_tag: { type: ['string', 'null'], maxLength: 30 },
            description: { type: ['string', 'null'], maxLength: 500 },
            archived: { type: 'boolean' },
          },
        },
        response: { 200: TIER_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number }
      const b = req.body as Record<string, unknown>
      const existing = db.prepare('SELECT * FROM membership_tiers WHERE id = ?').get(id) as TierRow | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })

      try {
        db.prepare(
          `UPDATE membership_tiers SET
            track = ?, code = ?, name = ?, sort = ?, discount_bp = ?,
            auto_upgrade = ?, color_tag = ?, description = ?, archived = ?
           WHERE id = ?`,
        ).run(
          (b.track as string) ?? existing.track,
          (b.code as string) ?? existing.code,
          (b.name as string) ?? existing.name,
          (b.sort as number) ?? existing.sort,
          (b.discount_bp as number) ?? existing.discount_bp,
          b.auto_upgrade !== undefined ? (b.auto_upgrade ? 1 : 0) : existing.auto_upgrade,
          b.color_tag !== undefined ? (b.color_tag as string | null) : existing.color_tag,
          b.description !== undefined ? (b.description as string | null) : existing.description,
          b.archived !== undefined ? (b.archived ? 1 : 0) : existing.archived,
          id,
        )
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          return reply.status(409).send({ error: 'code_exists' })
        }
        throw err
      }

      const updated = db.prepare('SELECT * FROM membership_tiers WHERE id = ?').get(id) as TierRow
      const criteria = db.prepare('SELECT * FROM tier_criteria WHERE tier_id = ?').all(id) as CriterionRow[]
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'membership.tier.update',
        targetType: 'membership_tier',
        targetId: String(id),
        summary: `更新等级 ${updated.code}`,
      })
      return tierDto(updated, criteria)
    },
  )

  app.delete(
    '/api/admin/membership/tiers/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
        response: { 204: { type: 'null' }, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number }
      const existing = db.prepare('SELECT * FROM membership_tiers WHERE id = ?').get(id) as TierRow | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })

      const bound = db
        .prepare('SELECT COUNT(*) AS n FROM user_memberships WHERE tier_id = ?')
        .get(id) as { n: number }
      const referenced = db
        .prepare('SELECT COUNT(*) AS n FROM orders WHERE membership_tier_id = ?')
        .get(id) as { n: number }

      if (bound.n > 0 || referenced.n > 0) {
        db.prepare('UPDATE membership_tiers SET archived = 1 WHERE id = ?').run(id)
        audit(db, {
          actorId: req.user?.id ?? null,
          action: 'membership.tier.archive',
          targetType: 'membership_tier',
          targetId: String(id),
          summary: `归档等级 ${existing.code}（有 ${bound.n} 绑定 / ${referenced.n} 订单引用）`,
        })
        return reply.status(204).send()
      }

      db.transaction(() => {
        db.prepare('DELETE FROM tier_criteria WHERE tier_id = ?').run(id)
        db.prepare('DELETE FROM membership_tiers WHERE id = ?').run(id)
      })()

      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'membership.tier.delete',
        targetType: 'membership_tier',
        targetId: String(id),
        summary: `删除等级 ${existing.code}`,
      })
      return reply.status(204).send()
    },
  )

  // ---------- Admin: tier criteria ----------

  app.put(
    '/api/admin/membership/tiers/:id/criteria',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
        body: {
          type: 'object',
          required: ['criteria'],
          additionalProperties: false,
          properties: {
            criteria: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['dimension', 'threshold'],
                additionalProperties: false,
                properties: {
                  dimension: { type: 'string', minLength: 1, maxLength: 50 },
                  op: { type: 'string', enum: ['gte', 'lte', 'eq'] },
                  threshold: { type: 'integer' },
                },
              },
            },
          },
        },
        response: { 200: TIER_SCHEMA, 404: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number }
      const { criteria } = req.body as { criteria: Array<{ dimension: string; op?: string; threshold: number }> }

      const tier = db.prepare('SELECT * FROM membership_tiers WHERE id = ?').get(id) as TierRow | undefined
      if (!tier) return reply.status(404).send({ error: 'not_found' })

      db.transaction(() => {
        db.prepare('DELETE FROM tier_criteria WHERE tier_id = ?').run(id)
        const insert = db.prepare(
          'INSERT INTO tier_criteria (tier_id, dimension, op, threshold) VALUES (?, ?, ?, ?)',
        )
        for (const c of criteria) {
          insert.run(id, c.dimension, c.op ?? 'gte', c.threshold)
        }
      })()

      const updated = db.prepare('SELECT * FROM tier_criteria WHERE tier_id = ?').all(id) as CriterionRow[]
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'membership.tier.criteria',
        targetType: 'membership_tier',
        targetId: String(id),
        summary: `设置 ${tier.code} 条件 ×${criteria.length}`,
      })
      return tierDto(tier, updated)
    },
  )

  // ---------- Admin: user assignment ----------

  app.post(
    '/api/admin/membership/assign',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['user_id', 'tier_id'],
          additionalProperties: false,
          properties: {
            user_id: { type: 'string', minLength: 1 },
            tier_id: { type: 'integer', minimum: 1 },
            notes: { type: ['string', 'null'], maxLength: 500 },
          },
        },
        response: { 200: { type: 'object', additionalProperties: true }, 404: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { user_id, tier_id, notes } = req.body as { user_id: string; tier_id: number; notes?: string | null }

      const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(user_id) as { id: string; name: string } | undefined
      if (!user) return reply.status(404).send({ error: 'user_not_found' })

      const tier = db.prepare('SELECT * FROM membership_tiers WHERE id = ? AND archived = 0').get(tier_id) as TierRow | undefined
      if (!tier) return reply.status(404).send({ error: 'tier_not_found' })

      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO user_memberships (user_id, track, tier_id, assigned_at, assigned_by, manual, notes)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(user_id, track) DO UPDATE SET
           tier_id = excluded.tier_id, assigned_at = excluded.assigned_at,
           assigned_by = excluded.assigned_by, manual = 1, notes = excluded.notes`,
      ).run(user_id, tier.track, tier_id, now, req.user?.id ?? null, notes ?? null)

      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'membership.assign',
        targetType: 'user',
        targetId: user_id,
        summary: `指派 ${user.name} → ${tier.code}`,
      })

      return { user_id, tier_id, track: tier.track, assigned_at: now }
    },
  )

  app.post(
    '/api/admin/membership/batch-assign',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['user_ids', 'tier_id'],
          additionalProperties: false,
          properties: {
            user_ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 200 },
            tier_id: { type: 'integer', minimum: 1 },
            notes: { type: ['string', 'null'], maxLength: 500 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['assigned', 'skipped'],
            additionalProperties: false,
            properties: {
              assigned: { type: 'integer' },
              skipped: { type: 'array', items: { type: 'string' } },
            },
          },
          404: ERROR_SCHEMA,
        },
      },
    },
    async (req, reply) => {
      const { user_ids, tier_id, notes } = req.body as { user_ids: string[]; tier_id: number; notes?: string | null }

      const tier = db.prepare('SELECT * FROM membership_tiers WHERE id = ? AND archived = 0').get(tier_id) as TierRow | undefined
      if (!tier) return reply.status(404).send({ error: 'tier_not_found' })

      const unique = [...new Set(user_ids)]
      const skipped: string[] = []
      const now = new Date().toISOString()
      const operatorId = req.user?.id ?? null

      const insertStmt = db.prepare(
        `INSERT INTO user_memberships (user_id, track, tier_id, assigned_at, assigned_by, manual, notes)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(user_id, track) DO UPDATE SET
           tier_id = excluded.tier_id, assigned_at = excluded.assigned_at,
           assigned_by = excluded.assigned_by, manual = 1, notes = excluded.notes`,
      )
      const userStmt = db.prepare('SELECT id, name FROM users WHERE id = ?')

      const run = db.transaction(() => {
        for (const uid of unique) {
          const user = userStmt.get(uid) as { id: string; name: string } | undefined
          if (!user) { skipped.push(uid); continue }
          insertStmt.run(uid, tier.track, tier_id, now, operatorId, notes ?? null)
          audit(db, {
            actorId: operatorId,
            action: 'membership.assign',
            targetType: 'user',
            targetId: uid,
            summary: `指派 ${user.name} → ${tier.code}`,
          })
        }
      })
      run()

      return { assigned: unique.length - skipped.length, skipped }
    },
  )

  app.post(
    '/api/admin/membership/remove',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['user_id', 'track'],
          additionalProperties: false,
          properties: {
            user_id: { type: 'string', minLength: 1 },
            track: { type: 'string', minLength: 1 },
          },
        },
        response: { 204: { type: 'null' }, 404: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { user_id, track } = req.body as { user_id: string; track: string }
      const { changes } = db
        .prepare('DELETE FROM user_memberships WHERE user_id = ? AND track = ?')
        .run(user_id, track)
      if (changes === 0) return reply.status(404).send({ error: 'not_found' })
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'membership.remove',
        targetType: 'user',
        targetId: user_id,
        summary: `移除 ${track} 轨会员`,
      })
      return reply.status(204).send()
    },
  )

  app.get(
    '/api/admin/membership/users',
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
      },
    },
    async () => {
      const rows = db
        .prepare(
          `SELECT um.user_id, um.track, um.tier_id, um.assigned_at, um.assigned_by, um.manual, um.expires_at,
                  u.name AS user_name, u.email AS user_email,
                  t.code AS tier_code, t.name AS tier_name, t.discount_bp
           FROM user_memberships um
           JOIN users u ON u.id = um.user_id
           JOIN membership_tiers t ON t.id = um.tier_id
           ORDER BY t.discount_bp DESC, t.sort DESC`,
        )
        .all() as Array<Record<string, unknown>>
      return rows.map((r) => ({ ...r, manual: (r['manual'] as number) !== 0 }))
    },
  )

  app.post(
    '/api/admin/membership/check-upgrade/:userId',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
          },
          404: ERROR_SCHEMA,
        },
      },
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string }
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined
      if (!user) return reply.status(404).send({ error: 'user_not_found' })

      const before = getUserMemberships(db, userId)
      checkAutoUpgrade(db, userId)
      const after = getUserMemberships(db, userId)

      return { before, after }
    },
  )

  // ---------- Admin: user dimension values ----------

  app.get(
    '/api/admin/membership/users/:userId/dimensions',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } },
        response: { 200: { type: 'object', additionalProperties: true }, 404: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string }
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined
      if (!user) return reply.status(404).send({ error: 'user_not_found' })

      const dimensions: Record<string, number> = {}
      for (const dim of ['order_count', 'order_amount']) {
        dimensions[dim] = computeDimension(db, userId, dim)
      }
      const custom = db
        .prepare('SELECT dimension, value FROM user_metrics WHERE user_id = ?')
        .all(userId) as Array<{ dimension: string; value: number }>
      for (const m of custom) {
        dimensions[m.dimension] = m.value
      }
      return { user_id: userId, dimensions }
    },
  )

  // ---------- Public: my membership ----------

  app.get(
    '/api/me/membership',
    {
      preHandler: requireUser,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              effective: {
                type: ['object', 'null'],
                additionalProperties: false,
                properties: {
                  tier_id: { type: 'integer' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  discount_bp: { type: 'integer' },
                  track: { type: 'string' },
                  color_tag: { type: ['string', 'null'] },
                },
              },
              memberships: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const userId = req.user!.id
      return {
        effective: getEffectiveTier(db, userId),
        memberships: getUserMemberships(db, userId).map((m) => ({ ...m, manual: m.manual !== 0 })),
      }
    },
  )
}
