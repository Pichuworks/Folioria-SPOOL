import { randomUUID } from 'node:crypto'
import { type FastifyInstance } from 'fastify'
import { audit } from './audit.js'
import { type DB } from './db.js'
import { requireAdmin, requireUser } from './guards.js'

interface AnnouncementRow {
  id: string
  title: string
  body: string
  audience: string
  pinned: number
  pin_sort: number
  published_at: string | null
  expires_at: string | null
  author_id: string
  archived: number
  created_at: string
  updated_at: string
}

function audienceFilter(role: 'customer' | 'member' | 'admin'): string[] {
  const audiences = ['public', 'all']
  if (role === 'customer') audiences.push('customers')
  else audiences.push('staff')
  return audiences
}

function visibleWhere(audiences: string[]): string {
  const placeholders = audiences.map(() => '?').join(',')
  return `published_at IS NOT NULL AND archived = 0
    AND (expires_at IS NULL OR expires_at > ?)
    AND audience IN (${placeholders})`
}

function toBool(row: AnnouncementRow) {
  return { ...row, pinned: row.pinned !== 0, archived: row.archived !== 0 }
}

export function registerAnnouncementsRoutes(app: FastifyInstance, db: DB): void {
  // ── 公开端点（无鉴权）──────────────────────────────────────────

  app.get(
    '/api/public-announcements',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
                pinned: { type: 'boolean' },
                pin_sort: { type: 'integer' },
                published_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async () => {
      const now = new Date().toISOString()
      const rows = db
        .prepare(
          `SELECT id, title, body, pinned, pin_sort, published_at FROM announcements
           WHERE published_at IS NOT NULL AND archived = 0
             AND (expires_at IS NULL OR expires_at > ?)
             AND audience = 'public'
           ORDER BY pinned DESC, pin_sort ASC, published_at DESC LIMIT 20`,
        )
        .all(now) as Array<Pick<AnnouncementRow, 'id' | 'title' | 'body' | 'pinned' | 'pin_sort' | 'published_at'>>
      return rows.map((r) => ({ ...r, pinned: r.pinned !== 0 }))
    },
  )

  // ── 下单域（requireUser）─────────────────────────────────────

  app.get('/api/announcements', { preHandler: requireUser }, async (req) => {
    const role = req.user!.role
    const audiences = audienceFilter(role)
    const now = new Date().toISOString()
    const where = visibleWhere(audiences)
    const rows = db
      .prepare(
        `SELECT a.id, a.title, a.body, a.audience, a.pinned, a.pin_sort, a.published_at,
                CASE WHEN ar.user_id IS NOT NULL THEN 1 ELSE 0 END AS read
         FROM announcements a
         LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = ?
         WHERE ${where}
         ORDER BY a.pinned DESC, a.pin_sort ASC, a.published_at DESC`,
      )
      .all(req.user!.id, now, ...audiences) as Array<{
      id: string; title: string; body: string; audience: string; pinned: number; pin_sort: number; published_at: string; read: number
    }>
    return rows.map((r) => ({ ...r, pinned: r.pinned !== 0, read: r.read !== 0 }))
  })

  app.get('/api/announcements/unread-count', { preHandler: requireUser }, async (req) => {
    const role = req.user!.role
    const audiences = audienceFilter(role)
    const now = new Date().toISOString()
    const where = visibleWhere(audiences)
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM announcements a
         LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = ?
         WHERE ${where} AND ar.user_id IS NULL`,
      )
      .get(req.user!.id, now, ...audiences) as { n: number }
    return { count: row.n }
  })

  app.post(
    '/api/announcements/:id/read',
    { preHandler: requireUser },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const audiences = audienceFilter(req.user!.role)
      const placeholders = audiences.map(() => '?').join(',')
      const exists = db
        .prepare(
          `SELECT id FROM announcements WHERE id = ? AND published_at IS NOT NULL AND archived = 0
           AND (expires_at IS NULL OR expires_at > ?) AND audience IN (${placeholders})`,
        )
        .get(id, new Date().toISOString(), ...audiences)
      if (!exists) return reply.status(404).send({ error: 'not_found' })
      db.prepare(
        'INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)',
      ).run(id, req.user!.id, new Date().toISOString())
      return reply.status(204).send()
    },
  )

  // ── 管理域（requireAdmin）────────────────────────────────────

  app.get('/api/admin/announcements', { preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        `SELECT a.*, u.name AS author_name
         FROM announcements a
         LEFT JOIN users u ON u.id = a.author_id
         ORDER BY a.pinned DESC, a.pin_sort ASC, a.created_at DESC
         LIMIT 500`,
      )
      .all() as Array<AnnouncementRow & { author_name: string | null }>
    return rows.map((r) => ({ ...toBool(r), author_name: r.author_name }))
  })

  const createSchema = {
    body: {
      type: 'object',
      required: ['title'],
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', maxLength: 10000 },
        audience: { type: 'string', enum: ['public', 'all', 'customers', 'staff'] },
        pinned: { type: 'boolean' },
        pin_sort: { type: 'integer', minimum: 0 },
        expires_at: { type: ['string', 'null'] },
        publish: { type: 'boolean' },
      },
    },
  }

  app.post(
    '/api/admin/announcements',
    { preHandler: requireAdmin, schema: createSchema },
    async (req, reply) => {
      const { title, body = '', audience = 'all', pinned = false, pin_sort = 0, expires_at = null, publish = false } =
        req.body as {
          title: string
          body?: string
          audience?: string
          pinned?: boolean
          pin_sort?: number
          expires_at?: string | null
          publish?: boolean
        }
      const now = new Date().toISOString()
      const id = randomUUID()
      const published_at = publish ? now : null

      db.prepare(
        `INSERT INTO announcements (id, title, body, audience, pinned, pin_sort, published_at, expires_at, author_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, title, body, audience, pinned ? 1 : 0, pin_sort, published_at, expires_at, req.user!.id, now, now)

      audit(db, {
        actorId: req.user!.id,
        action: 'announcement.create',
        targetType: 'announcement',
        targetId: id,
        summary: `创建公告「${title}」${publish ? '（已发布）' : '（草稿）'}`,
      })

      const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) as AnnouncementRow
      return reply.status(201).send(toBool(row))
    },
  )

  const updateSchema = {
    body: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', maxLength: 10000 },
        audience: { type: 'string', enum: ['public', 'all', 'customers', 'staff'] },
        pinned: { type: 'boolean' },
        pin_sort: { type: 'integer', minimum: 0 },
        expires_at: { type: ['string', 'null'] },
        published_at: { type: ['string', 'null'] },
      },
    },
  }

  app.patch(
    '/api/admin/announcements/:id',
    { preHandler: requireAdmin, schema: updateSchema },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const existing = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) as AnnouncementRow | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })

      const updates = req.body as Record<string, unknown>
      const now = new Date().toISOString()
      const sets: string[] = ['updated_at = ?']
      const params: unknown[] = [now]

      const PATCH_COLS = new Set(['title', 'body', 'audience', 'expires_at', 'published_at'])
      for (const [key, val] of Object.entries(updates)) {
        if (key === 'pinned') {
          sets.push('pinned = ?')
          params.push(val ? 1 : 0)
        } else if (key === 'pin_sort') {
          sets.push('pin_sort = ?')
          params.push(val)
        } else if (PATCH_COLS.has(key)) {
          sets.push(`${key} = ?`)
          params.push(val)
        }
      }
      params.push(id)

      db.prepare(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`).run(...params)

      audit(db, {
        actorId: req.user!.id,
        action: 'announcement.update',
        targetType: 'announcement',
        targetId: id,
        summary: `编辑公告「${existing.title}」`,
        detail: updates,
      })

      const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) as AnnouncementRow
      return toBool(row)
    },
  )

  app.patch(
    '/api/admin/announcements/:id/archive',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const existing = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) as AnnouncementRow | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      if (existing.archived) return reply.status(409).send({ error: 'already_archived' })

      db.prepare('UPDATE announcements SET archived = 1, pinned = 0, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id,
      )

      audit(db, {
        actorId: req.user!.id,
        action: 'announcement.archive',
        targetType: 'announcement',
        targetId: id,
        summary: `归档公告「${existing.title}」`,
      })

      return reply.status(204).send()
    },
  )
}
