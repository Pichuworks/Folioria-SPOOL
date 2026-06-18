import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { type FastifyInstance } from 'fastify'
import { type SessionUser } from './auth.js'
import { audit, listAudit } from './audit.js'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { ERROR_SCHEMA, isConstraint } from './errors.js'
import { requireAdmin } from './guards.js'
import { formatMoney, money } from './money.js'
import { userDto, USER_DTO_SCHEMA } from './user-dto.js'
import { sendXlsx } from './xlsx.js'

export function registerUsersRoutes(app: FastifyInstance, db: DB): void {
  // ---------- 管理域: users（B1 账号供给） ----------

  app.get(
    '/api/admin/users',
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                username: { type: ['string', 'null'] },
                name: { type: 'string' },
                role: { type: 'string' },
                archived: { type: 'boolean' },
                created_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async () => {
      const rows = db
        .prepare(
          "SELECT id, email, username, name, role, archived, created_at FROM users WHERE id != 'guest' ORDER BY created_at",
        )
        .all() as Array<SessionUser & { archived: number; created_at: string }>
      return rows.map((r) => ({ ...r, archived: r.archived !== 0 }))
    },
  )

  app.post(
    '/api/admin/users',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['email', 'name', 'password', 'role'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3 },
            username: { type: 'string', pattern: '^[a-z0-9_]{3,30}$' },
            name: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 8 },
            role: { type: 'string', enum: ['customer', 'member', 'admin'] },
          },
        },
        response: { 201: USER_DTO_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const body = req.body as { email: string; username?: string; name: string; password: string; role: string }
      const id = randomUUID()
      try {
        // S3: 创建者知晓的初始密码不应永久有效 → 首登强制改密（D11 同初始 admin）。
        // D12: admin 手动供给的账号视为已验证（不走邮箱验证链路）
        const now = new Date().toISOString()
        db.prepare(
          `INSERT INTO users (id, email, username, password_hash, name, role, must_change_password, email_verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(id, body.email, body.username ?? null, await bcrypt.hash(body.password, 12), body.name, body.role, now, now)
      } catch (err) {
        // 部分唯一索引冲突报「index 'uniq_users_username'」，列约束报「users.email」；以 username 子串判别
        if (isConstraint(err, 'username')) {
          return reply.status(409).send({ error: 'username_taken' })
        }
        if (isConstraint(err, 'UNIQUE')) {
          return reply.status(409).send({ error: 'email_exists' })
        }
        throw err
      }
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'user.create',
        targetType: 'user',
        targetId: id,
        summary: `创建 ${body.role} · ${body.email}`,
      })
      return reply.status(201).send({
        id,
        email: body.email,
        username: body.username ?? null,
        name: body.name,
        role: body.role,
        must_change_password: true,
        email_verified: true,
      })
    },
  )

  app.patch(
    '/api/admin/users/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            role: { type: 'string', enum: ['customer', 'member', 'admin'] },
            archived: { type: 'boolean' },
          },
        },
        response: { 200: USER_DTO_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = req.body as { role?: string; archived?: boolean }
      const existing = db
        .prepare('SELECT id, email, name, role, must_change_password, archived FROM users WHERE id = ?')
        .get(id) as (SessionUser & { archived: number }) | undefined
      if (!existing) return reply.status(404).send({ error: 'not_found' })
      // S1: 最后一个活跃 admin 不可归档/降格（防实例永久失管）
      const losesAdmin =
        (body.role !== undefined && body.role !== 'admin') || body.archived === true
      if (existing.role === 'admin' && existing.archived === 0 && losesAdmin) {
        const { n } = db
          .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND archived = 0")
          .get() as { n: number }
        if (n <= 1) return reply.status(409).send({ error: 'last_admin' })
      }
      db.prepare('UPDATE users SET role = ?, archived = ? WHERE id = ?').run(
        body.role ?? existing.role,
        body.archived === undefined ? existing.archived : body.archived ? 1 : 0,
        id,
      )
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'user.update',
        targetType: 'user',
        targetId: id,
        summary: [
          body.role !== undefined && body.role !== existing.role ? `角色 ${existing.role}→${body.role}` : null,
          body.archived !== undefined && (body.archived ? 1 : 0) !== existing.archived
            ? body.archived
              ? '归档'
              : '恢复'
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || '无变更',
      })
      const updated = db
        .prepare(
          'SELECT id, email, username, name, contact_info, role, must_change_password, email_verified_at FROM users WHERE id = ?',
        )
        .get(id) as SessionUser
      return userDto(updated)
    },
  )

  // D29 审计审阅视图（admin）：倒序最近 200 条，actor 名 join
  app.get('/api/admin/audit', { preHandler: requireAdmin }, async () =>
    listAudit(db).map((a) => ({
      id: a.id,
      actor_id: a.actor_id,
      actor_name: a.actor_name,
      action: a.action,
      target_type: a.target_type,
      target_id: a.target_id,
      summary: a.summary,
      created_at: a.created_at,
    })),
  )

  app.get('/api/admin/audit/export', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = listAudit(db, 5000)
    return sendXlsx(reply, 'audit.xlsx', [
      {
        name: '操作审计',
        columns: [
          { header: '时间', key: 'created_at', width: 20 },
          { header: '操作', key: 'action', width: 18 },
          { header: '操作人', key: 'actor_name', width: 14 },
          { header: '目标类型', key: 'target_type', width: 12 },
          { header: '目标ID', key: 'target_id', width: 20 },
          { header: '摘要', key: 'summary', width: 35 },
        ],
        rows,
      },
    ])
  })

  // B2 客户 CRM 钻取（只读 join）：订单史 + 累计已收 + 欠款 + 联系方式
  app.get(
    '/api/admin/users/:id/summary',
    {
      preHandler: requireAdmin,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const user = db
        .prepare("SELECT id, email, username, name, role, contact_info, created_at FROM users WHERE id = ? AND id != 'guest'")
        .get(id) as
        | { id: string; email: string; username: string | null; name: string; role: string; contact_info: string | null; created_at: string }
        | undefined
      if (!user) return reply.status(404).send({ error: 'not_found' })
      const currency = baseCurrency(db)
      const orders = db
        .prepare(
          `SELECT id, order_number, status, total, paid_amount, created_at
           FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 200`,
        )
        .all(id) as Array<{ id: string; order_number: string; status: string; total: number; paid_amount: number; created_at: string }>
      let totalPaid = 0
      let outstanding = 0
      let activeCount = 0
      for (const o of orders) {
        totalPaid += o.paid_amount
        if (o.status !== 'cancelled') {
          outstanding += o.total - o.paid_amount
          activeCount += 1
        }
      }
      return {
        user,
        stats: {
          order_count: orders.length,
          active_count: activeCount,
          total_paid: totalPaid,
          total_paid_display: formatMoney(money(totalPaid), currency),
          outstanding,
          outstanding_display: formatMoney(money(outstanding), currency),
        },
        orders: orders.map((o) => ({
          ...o,
          total_display: formatMoney(money(o.total), currency),
          paid_amount_display: formatMoney(money(o.paid_amount), currency),
        })),
      }
    },
  )
}
