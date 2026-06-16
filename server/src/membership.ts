import { type DB } from './db.js'
import { roundHalfUp, type Money } from './money.js'

export interface TierRow {
  id: number
  track: string
  code: string
  name: string
  sort: number
  discount_bp: number
  auto_upgrade: number
  color_tag: string | null
  description: string | null
  archived: number
  created_at: string
}

export interface CriterionRow {
  id: number
  tier_id: number
  dimension: string
  op: string
  threshold: number
}

export interface MembershipRow {
  user_id: string
  track: string
  tier_id: number
  assigned_at: string
  assigned_by: string | null
  manual: number
  expires_at: string | null
  notes: string | null
}

export interface EffectiveTier {
  tier_id: number
  code: string
  name: string
  discount_bp: number
  track: string
  color_tag: string | null
}

/** 跨轨取 max(discount_bp)，同 discount_bp 取 sort DESC */
export function getEffectiveTier(db: DB, userId: string): EffectiveTier | null {
  const now = new Date().toISOString()
  const row = db
    .prepare(
      `SELECT t.id AS tier_id, t.code, t.name, t.discount_bp, t.track, t.color_tag
       FROM user_memberships um
       JOIN membership_tiers t ON t.id = um.tier_id AND t.archived = 0
       WHERE um.user_id = ?
         AND (um.expires_at IS NULL OR um.expires_at > ?)
       ORDER BY t.discount_bp DESC, t.sort DESC
       LIMIT 1`,
    )
    .get(userId, now) as EffectiveTier | undefined
  return row ?? null
}

/** 全部绑定（多轨，用于 /api/me/membership 展示） */
export function getUserMemberships(
  db: DB,
  userId: string,
): Array<MembershipRow & { tier_code: string; tier_name: string; discount_bp: number; color_tag: string | null }> {
  const now = new Date().toISOString()
  return db
    .prepare(
      `SELECT um.*, t.code AS tier_code, t.name AS tier_name, t.discount_bp, t.color_tag
       FROM user_memberships um
       JOIN membership_tiers t ON t.id = um.tier_id AND t.archived = 0
       WHERE um.user_id = ?
         AND (um.expires_at IS NULL OR um.expires_at > ?)
       ORDER BY t.discount_bp DESC, t.sort DESC`,
    )
    .all(userId, now) as Array<
    MembershipRow & { tier_code: string; tier_name: string; discount_bp: number; color_tag: string | null }
  >
}

export function getUserDiscountBp(db: DB, userId: string): number {
  const tier = getEffectiveTier(db, userId)
  return tier?.discount_bp ?? 0
}

/** 会员折扣绝对金额：round_half_up(subtotal * bp / 10000) */
export function membershipDiscountAmount(subtotal: Money, discountBp: number): Money {
  if (discountBp <= 0) return 0 as Money
  return roundHalfUp((subtotal as number) * discountBp / 10000) as Money
}

const BUILTIN_DIMENSIONS: Record<string, string> = {
  order_count: `SELECT COUNT(*) AS v FROM orders WHERE customer_id = ? AND status = 'delivered'`,
  order_amount: `SELECT COALESCE(SUM(total), 0) AS v FROM orders WHERE customer_id = ? AND status = 'delivered'`,
}

export function computeDimension(db: DB, userId: string, dimension: string): number {
  const sql = BUILTIN_DIMENSIONS[dimension]
  if (sql) {
    const row = db.prepare(sql).get(userId) as { v: number }
    return row.v
  }
  const metric = db
    .prepare('SELECT value FROM user_metrics WHERE user_id = ? AND dimension = ?')
    .get(userId, dimension) as { value: number } | undefined
  return metric?.value ?? 0
}

function meetsAllCriteria(db: DB, userId: string, criteria: CriterionRow[]): boolean {
  for (const c of criteria) {
    const val = computeDimension(db, userId, c.dimension)
    switch (c.op) {
      case 'gte':
        if (val < c.threshold) return false
        break
      case 'lte':
        if (val > c.threshold) return false
        break
      case 'eq':
        if (val !== c.threshold) return false
        break
    }
  }
  return true
}

/**
 * 检查并执行自动升级。遍历所有 auto_upgrade=1 的轨道，
 * 找到满足条件的最高等级（sort DESC），升级（只升不降）。
 * manual=1 的绑定跳过不覆盖。
 */
export function checkAutoUpgrade(db: DB, userId: string): void {
  const tracks = db
    .prepare(
      `SELECT DISTINCT track FROM membership_tiers WHERE auto_upgrade = 1 AND archived = 0`,
    )
    .all() as Array<{ track: string }>

  const now = new Date().toISOString()

  for (const { track } of tracks) {
    const existing = db
      .prepare('SELECT tier_id, manual FROM user_memberships WHERE user_id = ? AND track = ?')
      .get(userId, track) as { tier_id: number; manual: number } | undefined

    if (existing?.manual) continue

    const tiers = db
      .prepare(
        `SELECT id, sort FROM membership_tiers
         WHERE track = ? AND auto_upgrade = 1 AND archived = 0
         ORDER BY sort DESC`,
      )
      .all(track) as Array<{ id: number; sort: number }>

    let bestTierId: number | null = null
    for (const t of tiers) {
      const criteria = db
        .prepare('SELECT * FROM tier_criteria WHERE tier_id = ?')
        .all(t.id) as CriterionRow[]
      if (criteria.length === 0) continue
      if (meetsAllCriteria(db, userId, criteria)) {
        bestTierId = t.id
        break
      }
    }

    if (bestTierId == null) continue

    if (existing) {
      const currentSort = db
        .prepare('SELECT sort FROM membership_tiers WHERE id = ?')
        .get(existing.tier_id) as { sort: number } | undefined
      const newSort = db
        .prepare('SELECT sort FROM membership_tiers WHERE id = ?')
        .get(bestTierId) as { sort: number } | undefined
      if (currentSort && newSort && newSort.sort <= currentSort.sort) continue
    }

    db.prepare(
      `INSERT INTO user_memberships (user_id, track, tier_id, assigned_at, manual)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(user_id, track) DO UPDATE SET tier_id = excluded.tier_id, assigned_at = excluded.assigned_at, assigned_by = NULL, manual = 0`,
    ).run(userId, track, bestTierId, now)
  }
}
