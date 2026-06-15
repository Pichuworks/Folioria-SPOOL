import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { collectForbiddenKeys, createTestUser, makeTestDb } from './test-helpers.js'

/** D35 文件预检集成：上传后 order_item.file_precheck 落账并经 DTO 暴露（两域售价侧，无禁用字段）。 */

function multipart(filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----spool-precheck-boundary'
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

let db: DB
let app: App
let uploadDir: string

beforeEach(() => {
  db = makeTestDb()
  spoolInit(db, { baseCurrency: 'JPY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'initial-secret-pw' })
  importSeed(db)
  createTestUser(db, { email: 'a@cust.example' })
  uploadDir = mkdtempSync(path.join(tmpdir(), 'spool-precheck-up-'))
  app = buildApp(db, { uploadDir, uploadMaxBytes: 10 * 1024 * 1024 })
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(uploadDir, { recursive: true, force: true })
})

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
  return `${SESSION_COOKIE}=${/spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1]}`
}

async function placeAndUpload(cookie: string, filename: string, content: Buffer) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie },
    payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 100 }] },
  })
  const order = created.json() as { id: string; items: Array<{ id: string }> }
  const { payload, headers } = multipart(filename, content)
  const res = await app.inject({
    method: 'POST',
    url: `/api/orders/${order.id}/items/${order.items[0]!.id}/file`,
    headers: { ...headers, cookie },
    payload,
  })
  return { order, res }
}

interface PrecheckDto {
  level: string
  items: Array<{ key: string; level: string; message: string }>
}
interface ItemDto {
  has_file: boolean
  file_precheck: PrecheckDto | null
}

describe('D35 上传集成：file_precheck 落账 + DTO 暴露', () => {
  it('低 DPI PNG → file_precheck.level=warn（dpi 警告），上传仍 201 不被阻断', async () => {
    const cookie = await login('a@cust.example')
    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } })
      .withMetadata({ density: 150 })
      .png()
      .toBuffer()
    const { res } = await placeAndUpload(cookie, 'low.png', png)
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { items: ItemDto[] }
    expect(dto.items[0]!.has_file).toBe(true)
    expect(dto.items[0]!.file_precheck?.level).toBe('warn')
    expect(dto.items[0]!.file_precheck?.items.some((i) => i.key === 'dpi' && i.level === 'warn')).toBe(true)
    // §6 下单域：预检消息不含 cost/profit/margin 键
    expect(collectForbiddenKeys(res.json())).toEqual([])
  })

  it('A4 PDF → file_precheck.level=info（页数 + 首页 210×297mm）', async () => {
    const cookie = await login('a@cust.example')
    const doc = await PDFDocument.create()
    doc.addPage([595.28, 841.89])
    const pdf = Buffer.from(await doc.save())
    const { res } = await placeAndUpload(cookie, 'a4.pdf', pdf)
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { items: ItemDto[] }
    expect(dto.items[0]!.file_precheck?.level).toBe('info')
    expect(dto.items[0]!.file_precheck?.items.some((i) => i.key === 'page_size' && /210×297mm/.test(i.message))).toBe(true)
  })

  it('重传刷新预检：低 DPI → 高 DPI 后 file_precheck 由 warn 转非 warn', async () => {
    const cookie = await login('a@cust.example')
    const low = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#fff' } }).withMetadata({ density: 150 }).png().toBuffer()
    const { order, res: first } = await placeAndUpload(cookie, 'low.png', low)
    expect((first.json() as { items: ItemDto[] }).items[0]!.file_precheck?.level).toBe('warn')

    const high = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#fff' } }).withMetadata({ density: 600 }).png().toBuffer()
    const { payload, headers } = multipart('high.png', high)
    const re = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${order.items[0]!.id}/file`,
      headers: { ...headers, cookie },
      payload,
    })
    const reDto = re.json() as { items: ItemDto[] }
    expect(reDto.items[0]!.file_precheck?.items.find((i) => i.key === 'dpi')?.level).toBe('ok')
    expect(reDto.items[0]!.file_precheck?.level).not.toBe('warn')
  })
})
