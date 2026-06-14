import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { collectForbiddenKeys, createTestUser, makeTestDb } from './test-helpers.js'

/**
 * D31 书组件文件上传/审稿（Track B 收尾）：与单页 item 同口径——纯书单不再无文件门，
 * confirm 须全部书组件有文件且 approved。复用 R5 白名单/magic/隔离存储/randomUUID/owner+admin 下载。
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png')])
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
let bookId: number
let innerId: number

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
  uploadDir = mkdtempSync(path.join(tmpdir(), 'spool-bookfiles-'))
  app = buildApp(db, { uploadDir, uploadMaxBytes: 1024 })

  bookId = Number(db.prepare("INSERT INTO book_products (name) VALUES ('写真集')").run().lastInsertRowid)
  db.prepare(
    "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'cover', 6, 'A3', 'color', 0, 0)",
  ).run(bookId)
  innerId = Number(
    db
      .prepare(
        "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'inner', 1, 'A4', 'bw', 0, 1)",
      )
      .run(bookId).lastInsertRowid,
  )
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(uploadDir, { recursive: true, force: true })
})

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
  const match = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
  return `${SESSION_COOKIE}=${match?.[1]}`
}

interface CompDto {
  id: string
  has_file: boolean
  file_status: string
  file_note: string | null
}
interface BookOrderDto {
  id: string
  status: string
  books: Array<{ components: CompDto[] }>
}

async function placeBookOrder(cookie: string): Promise<BookOrderDto> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie },
    payload: { books: [{ book_id: bookId, count: 5, components: [{ component_id: innerId, sheets_per_book: 10 }] }] },
  })
  expect(res.statusCode).toBe(201)
  return res.json() as BookOrderDto
}

async function uploadComponent(
  cookie: string,
  orderId: string,
  compId: string,
  filename: string,
  content: Buffer,
): Promise<{ statusCode: number; body: BookOrderDto | { error?: string } }> {
  const { payload, headers } = multipartPayload(filename, content)
  const res = await app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/book-components/${compId}/file`,
    headers: { ...headers, cookie },
    payload,
  })
  return { statusCode: res.statusCode, body: res.json() as BookOrderDto | { error?: string } }
}

async function review(
  adminCookie: string,
  orderId: string,
  compId: string,
  file_status: 'approved' | 'rejected',
  file_note?: string,
): Promise<BookOrderDto> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/book-components/${compId}/file-review`,
    headers: { cookie: adminCookie },
    payload: { file_status, ...(file_note != null ? { file_note } : {}) },
  })
  return res.json() as BookOrderDto
}

describe('D31 书组件上传：白名单 / 隔离存储 / 自动流转', () => {
  it('组件 PDF 上传成功：randomUUID 存储名、has_file/pending、§6 无 cost 键', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeBookOrder(cookie)
    expect(order.books[0]!.components).toHaveLength(2)
    const innerComp = order.books[0]!.components.find((c) => c.has_file === false)!
    const res = await uploadComponent(cookie, order.id, order.books[0]!.components[0]!.id, 'cover.pdf', PDF)
    expect(res.statusCode).toBe(201)
    const dto = res.body as BookOrderDto
    expect(dto.books[0]!.components.some((c) => c.has_file && c.file_status === 'pending')).toBe(true)
    expect(dto.status).toBe('quoted') // 还有一个组件没传，不流转
    expect(collectForbiddenKeys(res.body)).toEqual([])
    const stored = readdirSync(uploadDir)
    expect(stored.length).toBe(1)
    expect(stored[0]).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    void innerComp
  })

  it('全部组件传齐 → 自动 file_pending；全部 approved → file_approved', async () => {
    const cookie = await login('a@cust.example')
    const admin = await login('staff@folioria.jp')
    const order = await placeBookOrder(cookie)
    const [c0, c1] = order.books[0]!.components
    await uploadComponent(cookie, order.id, c0!.id, 'a.pdf', PDF)
    const second = await uploadComponent(cookie, order.id, c1!.id, 'b.png', PNG)
    expect((second.body as BookOrderDto).status).toBe('file_pending')

    await review(admin, order.id, c0!.id, 'approved')
    const afterSecond = await review(admin, order.id, c1!.id, 'approved')
    expect(afterSecond.status).toBe('file_approved')
  })

  it('改名伪装（EXE→.pdf）magic 不符 → 415 且不落盘', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeBookOrder(cookie)
    const res = await uploadComponent(cookie, order.id, order.books[0]!.components[0]!.id, 'evil.pdf', EXE)
    expect(res.statusCode).toBe(415)
    expect((res.body as { error: string }).error).toBe('file_content_mismatch')
    expect(readdirSync(uploadDir)).toEqual([])
  })

  it('归属门：他人 404、guest 401', async () => {
    const cookieA = await login('a@cust.example')
    const cookieB = await login('b@cust.example')
    const order = await placeBookOrder(cookieA)
    const compId = order.books[0]!.components[0]!.id
    expect((await uploadComponent(cookieB, order.id, compId, 'x.pdf', PDF)).statusCode).toBe(404)
    const { payload, headers } = multipartPayload('x.pdf', PDF)
    const noAuth = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/book-components/${compId}/file`,
      headers,
      payload,
    })
    expect(noAuth.statusCode).toBe(401)
  })
})

describe('D31 书组件审稿 / 文件门 confirm', () => {
  it('驳回重传：file_status 重置 pending、note 清空、订单留 file_pending', async () => {
    const cookieA = await login('a@cust.example')
    const admin = await login('staff@folioria.jp')
    const order = await placeBookOrder(cookieA)
    const [c0, c1] = order.books[0]!.components
    await uploadComponent(cookieA, order.id, c0!.id, 'a.pdf', PDF)
    await uploadComponent(cookieA, order.id, c1!.id, 'b.pdf', PDF) // → file_pending

    const rejected = await review(admin, order.id, c0!.id, 'rejected', '出血不足')
    expect(rejected.status).toBe('file_pending')
    const oldStored = readdirSync(uploadDir).length

    const re = await uploadComponent(cookieA, order.id, c0!.id, 'a2.png', PNG)
    expect(re.statusCode).toBe(201)
    const reDto = re.body as BookOrderDto
    const reComp = reDto.books[0]!.components.find((c) => c.id === c0!.id)!
    expect(reComp.file_status).toBe('pending')
    expect(reComp.file_note).toBeNull()
    expect(reDto.status).toBe('file_pending')
    expect(readdirSync(uploadDir).length).toBe(oldStored) // 旧文件清理，数量不增
  })

  it('纯书单文件门：未审稿 confirm 409；审稿全过后 confirm 200', async () => {
    const cookieA = await login('a@cust.example')
    const admin = await login('staff@folioria.jp')
    const order = await placeBookOrder(cookieA)
    const [c0, c1] = order.books[0]!.components

    const early = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: admin },
      payload: { status: 'confirmed' },
    })
    expect(early.statusCode).toBe(409)

    await uploadComponent(cookieA, order.id, c0!.id, 'a.pdf', PDF)
    await uploadComponent(cookieA, order.id, c1!.id, 'b.pdf', PDF)
    await review(admin, order.id, c0!.id, 'approved')
    await review(admin, order.id, c1!.id, 'approved')

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: admin },
      payload: { status: 'confirmed' },
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { status: string }).status).toBe('confirmed')
  })

  it('组件下载 owner/admin 可、他人 404、未上传 404', async () => {
    const cookieA = await login('a@cust.example')
    const cookieB = await login('b@cust.example')
    const admin = await login('staff@folioria.jp')
    const order = await placeBookOrder(cookieA)
    const compId = order.books[0]!.components[0]!.id
    const url = `/api/orders/${order.id}/book-components/${compId}/file`

    expect((await app.inject({ method: 'GET', url, headers: { cookie: cookieA } })).statusCode).toBe(404) // 未上传
    await uploadComponent(cookieA, order.id, compId, 'art.pdf', PDF)
    for (const c of [cookieA, admin]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: c } })
      expect(res.statusCode).toBe(200)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.rawPayload.equals(PDF)).toBe(true)
    }
    expect((await app.inject({ method: 'GET', url, headers: { cookie: cookieB } })).statusCode).toBe(404)
  })
})
