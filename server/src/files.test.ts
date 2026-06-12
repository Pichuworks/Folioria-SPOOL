import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { sniffMagic } from './files-routes.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { collectForbiddenKeys, createTestUser, makeTestDb } from './test-helpers.js'

/** R5 acceptance：白名单（扩展+magic 双查）/ 200MB 上限 / 隔离存储 / owner+admin 下载 / 重传重置 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
])
const TIFF = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.from('fake-tiff-body')])
const EXE = Buffer.from('MZ\x90\x00executable-not-art')

function multipartPayload(filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----spool-test-boundary'
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
  spoolInit(db, {
    baseCurrency: 'JPY',
    adminEmail: 'admin@folioria.jp',
    adminName: 'K君',
    adminPassword: 'initial-secret-pw',
  })
  importSeed(db)
  createTestUser(db, { email: 'a@cust.example' })
  createTestUser(db, { email: 'b@cust.example' })
  createTestUser(db, { email: 'staff@folioria.jp', role: 'admin' })
  uploadDir = mkdtempSync(path.join(tmpdir(), 'spool-uploads-'))
  app = buildApp(db, { uploadDir, uploadMaxBytes: 1024 })
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(uploadDir, { recursive: true, force: true })
})

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password' },
  })
  const match = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
  return `${SESSION_COOKIE}=${match?.[1]}`
}

interface OrderDto {
  id: string
  status: string
  items: Array<{ id: string; has_file: boolean; file_status: string; file_note: string | null }>
}

async function placeOrder(cookie: string, lines = 1): Promise<OrderDto> {
  const items = Array.from({ length: lines }, () => ({
    mode_id: 1,
    paper_id: 1,
    size_key: 'A4',
    quantity: 100,
  }))
  const res = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload: { items } })
  expect(res.statusCode).toBe(201)
  return res.json() as OrderDto
}

async function upload(
  cookie: string,
  order: OrderDto,
  itemIdx: number,
  filename: string,
  content: Buffer,
): Promise<{ statusCode: number; body: unknown }> {
  const { payload, headers } = multipartPayload(filename, content)
  const res = await app.inject({
    method: 'POST',
    url: `/api/orders/${order.id}/items/${order.items[itemIdx]?.id}/file`,
    headers: { ...headers, cookie },
    payload,
  })
  return { statusCode: res.statusCode, body: res.json() }
}

describe('magic bytes 探测', () => {
  it('PDF/PNG/TIFF(II/MM) 识别；其余 null', () => {
    expect(sniffMagic(PDF)).toBe('pdf')
    expect(sniffMagic(PNG)).toBe('png')
    expect(sniffMagic(TIFF)).toBe('tiff')
    expect(sniffMagic(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 1, 2, 3, 4]))).toBe('tiff')
    expect(sniffMagic(EXE)).toBe(null)
    expect(sniffMagic(Buffer.alloc(0))).toBe(null)
  })
})

describe('R5 上传：白名单与隔离存储', () => {
  it('PDF 上传成功：randomUUID 存储名（不落原始文件名）、item 置 pending、响应过白名单', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, 2)
    const res = await upload(cookie, order, 0, '我的作品 v2 (final).pdf', PDF)
    expect(res.statusCode).toBe(201)
    const dto = res.body as OrderDto
    expect(dto.items[0]?.has_file).toBe(true)
    expect(dto.items[0]?.file_status).toBe('pending')
    expect(dto.status).toBe('quoted') // 还有一个 item 没传，不流转
    expect(collectForbiddenKeys(res.body)).toEqual([])

    const stored = readdirSync(uploadDir)
    expect(stored.length).toBe(1)
    expect(stored[0]).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    // 库内 file_url 即存储名，无路径、无原名
    const row = db.prepare('SELECT file_url FROM order_items WHERE id = ?').get(order.items[0]?.id) as {
      file_url: string
    }
    expect(row.file_url).toBe(stored[0])
  })

  it('全部 item 传齐 → 自动 file_pending（R1 定点）', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, 2)
    await upload(cookie, order, 0, 'a.pdf', PDF)
    const second = await upload(cookie, order, 1, 'b.png', PNG)
    expect((second.body as OrderDto).status).toBe('file_pending')
  })

  it('扩展名白名单外（.exe/.svg）→ 415；改名伪装（EXE→.pdf）magic 不符 → 415 且不落盘', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie)
    expect((await upload(cookie, order, 0, 'evil.exe', EXE)).statusCode).toBe(415)
    expect((await upload(cookie, order, 0, 'vector.svg', Buffer.from('<svg/>'))).statusCode).toBe(415)
    const disguised = await upload(cookie, order, 0, 'evil.pdf', EXE)
    expect(disguised.statusCode).toBe(415)
    expect((disguised.body as { error: string }).error).toBe('file_content_mismatch')
    expect(readdirSync(uploadDir)).toEqual([])
    const row = db.prepare('SELECT file_url FROM order_items WHERE id = ?').get(order.items[0]?.id) as {
      file_url: string | null
    }
    expect(row.file_url).toBeNull()
  })

  it('超过大小上限 → 413 且不留半截文件（测试实例上限 1KB）', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie)
    const big = Buffer.concat([PDF, Buffer.alloc(4096, 0x20)])
    const res = await upload(cookie, order, 0, 'big.pdf', big)
    expect(res.statusCode).toBe(413)
    expect(readdirSync(uploadDir)).toEqual([])
  })

  it('归属与状态门：他人 404、guest 401、confirmed 后 409', async () => {
    const cookieA = await login('a@cust.example')
    const cookieB = await login('b@cust.example')
    const adminCookie = await login('staff@folioria.jp')
    const order = await placeOrder(cookieA)

    expect((await upload(cookieB, order, 0, 'x.pdf', PDF)).statusCode).toBe(404)
    const { payload, headers } = multipartPayload('x.pdf', PDF)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file`,
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(401)

    // 推进到 file_approved：上传冻结
    await upload(cookieA, order, 0, 'x.pdf', PDF)
    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: 'approved' },
    })
    const frozen = await upload(cookieA, order, 0, 'late.pdf', PDF)
    expect(frozen.statusCode).toBe(409)
  })

  it('驳回重传：file_status 重置 pending、file_note 清空、旧文件清理、订单留 file_pending 等重审', async () => {
    const cookieA = await login('a@cust.example')
    const adminCookie = await login('staff@folioria.jp')
    const order = await placeOrder(cookieA)
    await upload(cookieA, order, 0, 'v1.pdf', PDF)

    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: 'rejected', file_note: '出血不足' },
    })
    expect((rejected.json() as OrderDto).status).toBe('file_pending')
    const oldStored = readdirSync(uploadDir)[0]

    const re = await upload(cookieA, order, 0, 'v2.png', PNG)
    expect(re.statusCode).toBe(201)
    const dto = re.body as OrderDto
    expect(dto.status).toBe('file_pending')
    expect(dto.items[0]?.file_status).toBe('pending')
    expect(dto.items[0]?.file_note).toBeNull()
    const stored = readdirSync(uploadDir)
    expect(stored.length).toBe(1)
    expect(stored[0]).not.toBe(oldStored)
    expect(stored[0]).toMatch(/\.png$/)

    // 重审通过 → file_approved
    const approved = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: 'approved' },
    })
    expect((approved.json() as OrderDto).status).toBe('file_approved')
  })
})

describe('R5 下载：owner/admin 限定 + attachment + nosniff', () => {
  it('owner 与 admin 可下载且字节一致；他人 404；guest 401；未上传 404', async () => {
    const cookieA = await login('a@cust.example')
    const cookieB = await login('b@cust.example')
    const adminCookie = await login('staff@folioria.jp')
    const order = await placeOrder(cookieA)
    const url = `/api/orders/${order.id}/items/${order.items[0]?.id}/file`

    expect((await app.inject({ method: 'GET', url, headers: { cookie: cookieA } })).statusCode).toBe(404)

    await upload(cookieA, order, 0, 'art.pdf', PDF)
    for (const c of [cookieA, adminCookie]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: c } })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename=/)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-type']).toBe('application/octet-stream')
      expect(res.rawPayload.equals(PDF)).toBe(true)
    }

    expect((await app.inject({ method: 'GET', url, headers: { cookie: cookieB } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
  })
})
