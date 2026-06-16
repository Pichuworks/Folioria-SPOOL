import { randomUUID } from 'node:crypto'
import { type DB } from './db.js'
import { getLog } from './logger.js'

export interface AuditInput {
  actorId?: string | null
  action: string
  targetType: string
  targetId?: string | null
  summary: string
  detail?: unknown
}

/**
 * D29 单一审计 choke-point。best-effort 留痕：写入失败只吞掉，绝不回滚/阻断业务
 * （审计是旁路证据，不应让一次记录失败把已生效的收款/定价回退）。
 */
export function audit(db: DB, input: AuditInput): void {
  try {
    db.prepare(
      `INSERT INTO admin_audit (id, actor_id, action, target_type, target_id, summary, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.actorId ?? null,
      input.action,
      input.targetType,
      input.targetId ?? null,
      input.summary,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      new Date().toISOString(),
    )
  } catch (err) {
    getLog().error({ err, action: input.action, target: `${input.targetType}/${input.targetId}` }, 'audit INSERT failed')
  }
}

export interface AuditRow {
  id: string
  actor_id: string | null
  action: string
  target_type: string
  target_id: string | null
  summary: string
  detail: string | null
  created_at: string
  actor_name: string | null
}

export function listAudit(db: DB, limit = 200): AuditRow[] {
  return db
    .prepare(
      `SELECT a.*, u.name AS actor_name
       FROM admin_audit a
       LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC, a.rowid DESC
       LIMIT ?`,
    )
    .all(limit) as AuditRow[]
}
