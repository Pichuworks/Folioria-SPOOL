import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { openDb } from './db.js'

export interface BackupOptions {
  keep: number
  stamp?: string
}

// review L-backup：含毫秒避免同秒两次备份撞名（VACUUM INTO 目标已存在会失败）。
// 'YYYYMMDD-HHmmss.SSS'，毫秒零填充故字典序仍等于时间序。
const stampNow = (): string =>
  new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 19)

/**
 * PRD E 节：备份一律 VACUUM INTO（一致性快照），禁止直接 cp（WAL 下不一致）。
 * 产物命名 folioria-<stamp>.db，目录内滚动保留 keep 份。
 */
export function backupDb(srcPath: string, destDir: string, opts: BackupOptions): string {
  if (!existsSync(srcPath)) throw new Error(`backup: source db not found: ${srcPath}`)
  mkdirSync(destDir, { recursive: true })
  const file = path.join(destDir, `folioria-${opts.stamp ?? stampNow()}.db`)

  const db = openDb(srcPath)
  try {
    db.prepare('VACUUM INTO ?').run(file)
  } finally {
    db.close()
  }

  const backups = readdirSync(destDir)
    .filter((f) => /^folioria-.+\.db$/.test(f))
    .sort()
  for (const stale of backups.slice(0, Math.max(0, backups.length - opts.keep))) {
    rmSync(path.join(destDir, stale))
  }
  return file
}

export interface BackupReport {
  ok: boolean
  integrity: string
  foreign_key_violations: number
  user_version: number
  error?: string
}

/** 恢复演练：只读打开备份，跑 integrity_check / foreign_key_check / user_version */
export function verifyBackup(file: string): BackupReport {
  if (!existsSync(file)) {
    return { ok: false, integrity: 'missing', foreign_key_violations: -1, user_version: -1, error: 'file_not_found' }
  }
  let db: Database.Database | null = null
  try {
    db = new Database(file, { readonly: true })
    const integrity = (db.pragma('integrity_check', { simple: true }) as string) ?? 'failed'
    const fkViolations = (db.pragma('foreign_key_check') as unknown[]).length
    const userVersion = db.pragma('user_version', { simple: true }) as number
    return {
      ok: integrity === 'ok' && fkViolations === 0,
      integrity,
      foreign_key_violations: fkViolations,
      user_version: userVersion,
    }
  } catch (err) {
    return {
      ok: false,
      integrity: 'error',
      foreign_key_violations: -1,
      user_version: -1,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    db?.close()
  }
}
