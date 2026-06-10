import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { backupDb, verifyBackup } from './backup.js'
import { migrate, openDb } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'

const USAGE = `spool <command>

commands:
  init           初始化实例: --db <file> [--base-currency JPY|CNY|USD] [--admin-email x] [--admin-name x] [--admin-password x]
                 缺省参数进入交互向导; 未提供 --admin-password 时自动生成并打印一次
  seed           导入 data/seed.json: --db <file>
  backup         VACUUM INTO 一致性快照: --db <file> --dest <dir> [--keep 30]（禁止直接 cp）
  verify-backup  恢复演练: --file <backup.db>（integrity / FK / user_version）
`

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: 'string', default: 'folioria.db' },
        'base-currency': { type: 'string' },
        'admin-email': { type: 'string' },
        'admin-name': { type: 'string' },
        'admin-password': { type: 'string' },
      },
    })
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ask = async (label: string, provided: string | undefined): Promise<string> => {
      if (provided !== undefined) return provided
      if (!process.stdin.isTTY) throw new Error(`spool init: missing --${label}`)
      return (await rl.question(`${label}: `)).trim()
    }
    try {
      const baseCurrency = (await ask('base-currency', values['base-currency'])).toUpperCase()
      const adminEmail = await ask('admin-email', values['admin-email'])
      const adminName = await ask('admin-name', values['admin-name'])
      let adminPassword = values['admin-password']
      let generated = false
      if (adminPassword === undefined) {
        adminPassword = randomBytes(12).toString('base64url')
        generated = true
      }
      const db = openDb(values.db)
      migrate(db)
      spoolInit(db, { baseCurrency, adminEmail, adminName, adminPassword })
      db.close()
      console.log(`initialized ${values.db} (base ${baseCurrency}, admin ${adminEmail})`)
      if (generated) console.log(`一次性初始密码（首次登录强制修改）: ${adminPassword}`)
    } finally {
      rl.close()
    }
  } else if (cmd === 'seed') {
    const { values } = parseArgs({
      args: rest,
      options: { db: { type: 'string', default: 'folioria.db' } },
    })
    const db = openDb(values.db)
    migrate(db)
    importSeed(db)
    db.close()
    console.log(`seeded ${values.db} from data/seed.json`)
  } else if (cmd === 'backup') {
    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: 'string', default: 'folioria.db' },
        dest: { type: 'string' },
        keep: { type: 'string', default: '30' },
      },
    })
    if (!values.dest) throw new Error('spool backup: missing --dest')
    const keep = Number(values.keep)
    if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('spool backup: invalid --keep')
    const file = backupDb(values.db, values.dest, { keep })
    const report = verifyBackup(file)
    console.log(`backup ${file} · verify ${report.ok ? 'OK' : `FAILED: ${report.integrity}`}`)
    if (!report.ok) process.exitCode = 1
  } else if (cmd === 'verify-backup') {
    const { values } = parseArgs({ args: rest, options: { file: { type: 'string' } } })
    if (!values.file) throw new Error('spool verify-backup: missing --file')
    const report = verifyBackup(values.file)
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
  } else {
    console.log(USAGE)
    process.exitCode = cmd ? 1 : 0
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
