import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { type DB } from './db.js'

export const SESSION_TTL_DAYS = 30
export const VERIFICATION_TTL_HOURS = 48
export const PASSWORD_RESET_TTL_HOURS = 2

export interface SessionUser {
  id: string
  email: string
  username: string | null
  name: string
  contact_info: string | null
  role: 'customer' | 'member' | 'admin'
  must_change_password: number
  email_verified_at: string | null
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSession(db: DB, userId: string): string {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(
    hashToken(token),
    userId,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_DAYS * 86_400_000).toISOString(),
  )
  return token
}

export function userByToken(db: DB, token: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.username, u.name, u.contact_info, u.role, u.must_change_password, u.email_verified_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.archived = 0`,
    )
    .get(hashToken(token), new Date().toISOString()) as SessionUser | undefined
  return row ?? null
}

/** R4: 签发邮箱验证 token——仅存哈希，返回明文（经邮件外送一次） */
export function issueEmailVerification(db: DB, userId: string): string {
  const token = randomBytes(32).toString('base64url')
  db.prepare(
    'INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
  ).run(hashToken(token), userId, new Date(Date.now() + VERIFICATION_TTL_HOURS * 3_600_000).toISOString())
  return token
}

/** R4: 一次性消费验证 token，置位 email_verified_at。无效/过期/已消费 → false */
export function verifyEmail(db: DB, token: string): boolean {
  const now = new Date().toISOString()
  const hash = hashToken(token)
  const row = db
    .prepare(
      `SELECT user_id FROM email_verification_tokens
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .get(hash, now) as { user_id: string } | undefined
  if (!row) return false
  db.transaction(() => {
    db.prepare('UPDATE email_verification_tokens SET consumed_at = ? WHERE token_hash = ?').run(
      now,
      hash,
    )
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL').run(
      now,
      row.user_id,
    )
  })()
  return true
}

export function revokeSession(db: DB, token: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(
    new Date().toISOString(),
    hashToken(token),
  )
}

// S2: 未知邮箱也比对一次的哑 hash（cost 12，与真实账号一致）；预生成常量避免启动期现算
const DUMMY_HASH = '$2b$12$USNoAd.LkznkSolTZdR9eOblhwfg.1kZ.ppLhoyc2Vk4dmMvhn7Ca'

export async function verifyLogin(db: DB, identifier: string, password: string): Promise<SessionUser | null> {
  // D18: 单一标识符——含 '@' 即邮箱口径，否则用户名口径；两者皆 NOCASE（email 列本就 NOCASE）
  const row = db
    .prepare(
      `SELECT id, email, username, name, contact_info, role, must_change_password, email_verified_at, password_hash
       FROM users WHERE (email = ? OR username = ? COLLATE NOCASE) AND archived = 0`,
    )
    .get(identifier, identifier) as (SessionUser & { password_hash: string }) | undefined
  const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH)
  if (!row || !ok) return null
  const { password_hash: _drop, ...user } = row
  void _drop
  return user
}

/** D19: 找用户以发重置邮件（用户名或邮箱，皆 NOCASE）；不存在返回 null（调用方不得据此泄露存在性） */
export function findUserForReset(db: DB, identifier: string): { id: string; email: string } | null {
  const row = db
    .prepare(
      `SELECT id, email FROM users WHERE (email = ? OR username = ? COLLATE NOCASE) AND archived = 0`,
    )
    .get(identifier, identifier) as { id: string; email: string } | undefined
  return row ?? null
}

/** D19: 签发密码重置 token——仅存哈希，返回明文经邮件外送一次 */
export function issuePasswordReset(db: DB, userId: string): string {
  const token = randomBytes(32).toString('base64url')
  db.prepare(
    'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
  ).run(hashToken(token), userId, new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 3_600_000).toISOString())
  return token
}

/** D19: 一次性消费重置 token，置新密码、清首登标志、撤销该用户全部会话与其它未消费 token。无效/过期/已用 → false */
export async function resetPassword(db: DB, token: string, newPassword: string): Promise<boolean> {
  const now = new Date().toISOString()
  const row = db
    .prepare(
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .get(hashToken(token), now) as { user_id: string } | undefined
  if (!row) return false
  const hash = await bcrypt.hash(newPassword, 12)
  db.transaction(() => {
    db.prepare('UPDATE password_reset_tokens SET consumed_at = ? WHERE token_hash = ?').run(now, hashToken(token))
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, row.user_id)
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, row.user_id)
    db.prepare(
      'UPDATE password_reset_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL',
    ).run(now, row.user_id)
  })()
  return true
}

/** H-SEC-4: purge expired/revoked sessions and consumed tokens */
export function cleanupExpiredTokens(db: DB): number {
  const now = new Date().toISOString()
  let deleted = 0
  deleted += db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').run(now).changes
  deleted += db.prepare('DELETE FROM email_verification_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL').run(now).changes
  deleted += db.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL').run(now).changes
  return deleted
}

/** 改密成功清 must_change_password（D11）并吊销该用户其他 session */
export async function changePassword(
  db: DB,
  userId: string,
  oldPassword: string,
  newPassword: string,
  keepToken?: string,
): Promise<boolean> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND archived = 0').get(userId) as
    | { password_hash: string }
    | undefined
  if (!row || !(await bcrypt.compare(oldPassword, row.password_hash))) return false
  const hash = await bcrypt.hash(newPassword, 12)
  const keepHash = keepToken === undefined ? null : hashToken(keepToken)
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
      hash,
      userId,
    )
    db.prepare(
      `UPDATE sessions SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR token_hash != ?)`,
    ).run(now, userId, keepHash, keepHash)
    // review L-auth：主动改密后作废该用户在途未消费的重置 token（与 resetPassword 对齐），
    // 防止已签发的重置链接在改密后仍可被持有者用来夺回账号。
    db.prepare(
      'UPDATE password_reset_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL',
    ).run(now, userId)
  })()
  return true
}
