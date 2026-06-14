import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupDb, verifyBackup } from './backup.js'
import { migrate, openDb } from './db.js'
import { importSeed } from './seed.js'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'spool-backup-'))
  dbPath = path.join(dir, 'folioria.db')
  const db = openDb(dbPath)
  migrate(db)
  db.prepare(
    "INSERT INTO system_config (id, base_currency, initialized_at) VALUES (1, 'JPY', '2026-06-10T00:00:00Z')",
  ).run()
  importSeed(db)
  db.close()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('T15 备份（VACUUM INTO，禁止 cp）', () => {
  it('备份产物可打开、integrity ok、数据完整、user_version 一致', () => {
    const dest = path.join(dir, 'backups')
    const file = backupDb(dbPath, dest, { keep: 30, stamp: '20260610-120000' })
    expect(existsSync(file)).toBe(true)

    const report = verifyBackup(file)
    expect(report.ok).toBe(true)
    expect(report.integrity).toBe('ok')
    expect(report.foreign_key_violations).toBe(0)
    expect(report.user_version).toBe(12)

    const backup = openDb(file)
    expect((backup.prepare('SELECT COUNT(*) n FROM combos').get() as { n: number }).n).toBe(70)
    backup.close()
  })

  it('滚动保留：超出 keep 的最旧备份被清理', () => {
    const dest = path.join(dir, 'backups')
    backupDb(dbPath, dest, { keep: 2, stamp: '20260601-000000' })
    backupDb(dbPath, dest, { keep: 2, stamp: '20260602-000000' })
    backupDb(dbPath, dest, { keep: 2, stamp: '20260603-000000' })
    const files = readdirSync(dest).sort()
    expect(files.length).toBe(2)
    expect(files[0]).toContain('20260602')
    expect(files[1]).toContain('20260603')
  })

  it('损坏文件（直接 cp 的 WAL 库或半截文件）验证失败', () => {
    const bogus = path.join(dir, 'bogus.db')
    rmSync(bogus, { force: true })
    const report = verifyBackup(bogus)
    expect(report.ok).toBe(false)
  })
})
