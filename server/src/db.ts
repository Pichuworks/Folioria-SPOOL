import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type DB = Database.Database

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

export function openDb(file: string): DB {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -64000')
  db.pragma('temp_store = MEMORY')
  return db
}

/** 按 0001_*.sql 序号应用未达版本的 migration，PRAGMA user_version 记账；返回本次应用数 */
export function migrate(db: DB, dir: string = MIGRATIONS_DIR): number {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
  const current = db.pragma('user_version', { simple: true }) as number
  let applied = 0
  for (const file of files) {
    const version = Number(file.slice(0, 4))
    if (version <= current) continue
    const sql = readFileSync(path.join(dir, file), 'utf8')
    const needsFkOff = /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql)
    if (needsFkOff) db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        db.exec(sql)
        db.pragma(`user_version = ${version}`)
      })()
    } catch (err) {
      console.error(`migration ${file} failed:`, err)
      throw err
    } finally {
      if (needsFkOff) db.pragma('foreign_keys = ON')
    }
    applied += 1
  }
  return applied
}
