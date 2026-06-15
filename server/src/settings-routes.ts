import { statSync } from 'node:fs'
import { type FastifyInstance } from 'fastify'
import { audit } from './audit.js'
import { type DB } from './db.js'
import { requireAdmin } from './guards.js'
import { invalidateConfigCache } from './pricing.js'

interface ConfigRow {
  base_currency: string
  min_margin_bp: number
  unify_pricing: number
  force_min_margin: number
  require_email_verification: number
  guest_orders_open: number
  overhead_dep_months: number
  overhead_month_volume: number
  quote_valid_days: number
  initialized_at: string | null
}

const toDto = (r: ConfigRow) => ({
  ...r,
  unify_pricing: r.unify_pricing !== 0,
  force_min_margin: r.force_min_margin !== 0,
  require_email_verification: r.require_email_verification !== 0,
  guest_orders_open: r.guest_orders_open !== 0,
})

const SELECT_CONFIG = `SELECT base_currency, min_margin_bp, unify_pricing, force_min_margin,
                              require_email_verification, guest_orders_open, overhead_dep_months,
                              overhead_month_volume, quote_valid_days, initialized_at
                       FROM system_config WHERE id = 1`

export function registerSettingsRoutes(app: FastifyInstance, db: DB): void {
  // 公开实例标志（无成本/利润字段，下单域可读）：首页/门/向导用
  app.get(
    '/api/public-config',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              initialized: { type: 'boolean' },
              require_email_verification: { type: 'boolean' },
              registration_open: { type: 'boolean' },
              guest_orders_open: { type: 'boolean' },
            },
          },
        },
      },
    },
    async () => {
      const row = db
        .prepare(
          'SELECT require_email_verification, registration_open, guest_orders_open FROM system_config WHERE id = 1',
        )
        .get() as
        | { require_email_verification: number; registration_open: number; guest_orders_open: number }
        | undefined
      return {
        initialized: row != null,
        require_email_verification: (row?.require_email_verification ?? 0) !== 0,
        registration_open: (row?.registration_open ?? 1) !== 0,
        guest_orders_open: (row?.guest_orders_open ?? 0) !== 0,
      }
    },
  )

  app.get('/api/settings', { preHandler: requireAdmin }, async () => {
    const row = db.prepare(SELECT_CONFIG).get() as ConfigRow | undefined
    if (!row) throw new Error('settings: system_config missing (run spool init)')
    return toDto(row)
  })

  app.patch(
    '/api/settings',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            base_currency: { type: 'string', minLength: 3, maxLength: 3 },
            // 10000bp = 100% 会让地板价公式除零，上限 9999
            min_margin_bp: { type: 'integer', minimum: 0, maximum: 9999 },
            unify_pricing: { type: 'boolean' },
            force_min_margin: { type: 'boolean' },
            require_email_verification: { type: 'boolean' },
            guest_orders_open: { type: 'boolean' },
            overhead_dep_months: { type: 'integer', minimum: 1 },
            overhead_month_volume: { type: 'integer', minimum: 1 },
            quote_valid_days: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as Partial<{
        base_currency: string
        min_margin_bp: number
        unify_pricing: boolean
        force_min_margin: boolean
        require_email_verification: boolean
        guest_orders_open: boolean
        overhead_dep_months: number
        overhead_month_volume: number
        quote_valid_days: number
      }>
      const existing = db.prepare(SELECT_CONFIG).get() as ConfigRow | undefined
      if (!existing) throw new Error('settings: system_config missing (run spool init)')

      if (b.base_currency !== undefined && b.base_currency !== existing.base_currency) {
        // 产生业务数据后锁定（换币种=新实例，PRD D7）
        const hasBusinessData = db
          .prepare(
            'SELECT EXISTS (SELECT 1 FROM orders) OR EXISTS (SELECT 1 FROM jobs) OR EXISTS (SELECT 1 FROM inventory_log) AS x',
          )
          .get() as { x: number }
        if (hasBusinessData.x) {
          return reply.status(409).send({ error: 'base_currency_locked' })
        }
        if (!db.prepare('SELECT 1 FROM currencies WHERE code = ?').get(b.base_currency)) {
          return reply.status(409).send({ error: 'unknown_currency' })
        }
      }

      db.prepare(
        `UPDATE system_config SET base_currency = ?, min_margin_bp = ?, unify_pricing = ?,
           force_min_margin = ?, require_email_verification = ?, guest_orders_open = ?,
           overhead_dep_months = ?, overhead_month_volume = ?, quote_valid_days = ?
         WHERE id = 1`,
      ).run(
        b.base_currency ?? existing.base_currency,
        b.min_margin_bp ?? existing.min_margin_bp,
        b.unify_pricing === undefined ? existing.unify_pricing : b.unify_pricing ? 1 : 0,
        b.force_min_margin === undefined ? existing.force_min_margin : b.force_min_margin ? 1 : 0,
        b.require_email_verification === undefined
          ? existing.require_email_verification
          : b.require_email_verification
            ? 1
            : 0,
        b.guest_orders_open === undefined ? existing.guest_orders_open : b.guest_orders_open ? 1 : 0,
        b.overhead_dep_months ?? existing.overhead_dep_months,
        b.overhead_month_volume ?? existing.overhead_month_volume,
        b.quote_valid_days ?? existing.quote_valid_days,
      )
      invalidateConfigCache()
      audit(db, {
        actorId: req.user?.id ?? null,
        action: 'settings.update',
        targetType: 'settings',
        targetId: '1',
        summary: `更新设置：${Object.keys(b).join(', ')}`,
        detail: b,
      })
      return toDto(db.prepare(SELECT_CONFIG).get() as ConfigRow)
    },
  )

  app.get('/api/settings/system-info', { preHandler: requireAdmin }, async () => {
    const userCount = (db.prepare("SELECT COUNT(*) n FROM users WHERE id != 'guest'").get() as { n: number }).n
    const orderCount = (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n
    const jobCount = (db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number }).n
    let dbSizeMb = '—'
    try {
      const dbPath = (db as unknown as { name: string }).name
      if (dbPath) dbSizeMb = (statSync(dbPath).size / 1024 / 1024).toFixed(2) + ' MB'
    } catch { /* non-file db (e.g. :memory:) */ }
    const hasResendKey = !!process.env['SPOOL_RESEND_API_KEY']
    return {
      node_version: process.version,
      db_size: dbSizeMb,
      user_count: userCount,
      order_count: orderCount,
      job_count: jobCount,
      email_configured: hasResendKey,
    }
  })
}
