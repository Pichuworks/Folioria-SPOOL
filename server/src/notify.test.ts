import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { emailChannel, notifyAddress, notifyUser, templates, verificationLink } from './notify.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

/** R7/D6: Notifier 抽象层。无 key → skipped 落 notification_log 不阻塞业务；HTTP 失败 → failed 同样不阻塞 */

const PDF = Buffer.from('%PDF-1.4\nminimal\n%%EOF\n')

function multipartPayload(filename: string, content: Buffer) {
  const boundary = '----spool-notify-boundary'
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

interface LogRow {
  event: string
  channel: string
  recipient: string
  status: string
  error: string | null
}

const logRows = (db: DB, event?: string): LogRow[] =>
  db
    .prepare(
      `SELECT event, channel, recipient, status, error FROM notification_log
       ${event ? 'WHERE event = ?' : ''} ORDER BY sent_at`,
    )
    .all(...(event ? [event] : [])) as LogRow[]

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
  createTestUser(db, { email: 'staff@folioria.jp', role: 'admin' })
  uploadDir = mkdtempSync(path.join(tmpdir(), 'spool-notify-'))
  app = buildApp(db, { uploadDir })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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
  order_number: string
  items: Array<{ id: string }>
}

async function orderInReview(cookie: string): Promise<OrderDto> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie },
    payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 100 }] },
  })
  const order = created.json() as OrderDto
  const { payload, headers } = multipartPayload('art.pdf', PDF)
  const up = await app.inject({
    method: 'POST',
    url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file`,
    headers: { ...headers, cookie },
    payload,
  })
  expect(up.statusCode).toBe(201)
  return order
}

describe('email adapter（Resend）', () => {
  it('无 SPOOL_RESEND_API_KEY → skipped（dev 降级，不出网）', async () => {
    const r = await emailChannel().send('x@y.example', { subject: 's', text: 't' })
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe(true)
  })

  it('有 key：HTTP 200 → sent；HTTP 500 → failed；fetch 异常 → failed（均不抛）', async () => {
    vi.stubEnv('SPOOL_RESEND_API_KEY', 'test-key')
    vi.stubEnv('SPOOL_MAIL_FROM', 'Folioria <spool@folioria.com>')

    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    expect((await emailChannel().send('x@y.example', { subject: 's', text: 't' })).ok).toBe(true)
    expect(calls[0]?.url).toBe('https://api.resend.com/emails')
    expect(String(calls[0]?.init.headers && (calls[0].init.headers as Record<string, string>)['authorization'])).toBe(
      'Bearer test-key',
    )

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('err', { status: 500 })))
    const failed = await emailChannel().send('x@y.example', { subject: 's', text: 't' })
    expect(failed.ok).toBe(false)
    expect(failed.error).toBe('resend_http_500')

    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    const thrown = await emailChannel().send('x@y.example', { subject: 's', text: 't' })
    expect(thrown.ok).toBe(false)
    expect(thrown.error).toContain('ECONNREFUSED')
  })
})

describe('notification_log 留痕', () => {
  it('notifyAddress：skipped 落一行', async () => {
    await notifyAddress(db, 'email_verification', 'x@y.example', { subject: 's', text: 't' })
    const rows = logRows(db)
    expect(rows).toEqual([
      { event: 'email_verification', channel: 'email', recipient: 'x@y.example', status: 'skipped', error: null },
    ])
  })

  it('notifyUser 尊重订阅：notify_channels=[] → 不发不留痕；notify_addresses 覆盖收件地址', async () => {
    const mute = createTestUser(db, { email: 'mute@cust.example' })
    db.prepare("UPDATE users SET notify_channels = '[]' WHERE id = ?").run(mute)
    await notifyUser(db, 'order_ready', mute, { subject: 's', text: 't' })
    expect(logRows(db).length).toBe(0)

    const alt = createTestUser(db, { email: 'alt@cust.example' })
    db.prepare('UPDATE users SET notify_addresses = ? WHERE id = ?').run('{"email":"inbox@other.example"}', alt)
    await notifyUser(db, 'order_ready', alt, { subject: 's', text: 't' })
    expect(logRows(db)[0]?.recipient).toBe('inbox@other.example')
  })

  it('HTTP 失败 → failed 行 + error 留痕，调用不抛', async () => {
    vi.stubEnv('SPOOL_RESEND_API_KEY', 'test-key')
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('err', { status: 422 })))
    await notifyAddress(db, 'order_ready', 'x@y.example', { subject: 's', text: 't' })
    const row = logRows(db)[0]
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('resend_http_422')
  })
})

describe('业务事件接入（D6 事件枚举）', () => {
  it('注册 → email_verification 留痕（无 key skipped），注册本身 201 不被阻塞', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'reg@cust.example', name: '新客', password: 'fresh-password-1' },
    })
    expect(res.statusCode).toBe(201)
    const rows = logRows(db, 'email_verification')
    expect(rows.length).toBe(1)
    expect(rows[0]?.recipient).toBe('reg@cust.example')
    expect(rows[0]?.status).toBe('skipped')
  })

  it('文件传齐 → order_file_pending 广播全部活跃 admin；确认/可取 → 通知客户', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await orderInReview(cookie)

    const pendingRows = logRows(db, 'order_file_pending')
    // 活跃 admin：init admin + staff
    expect(pendingRows.map((r) => r.recipient).sort()).toEqual(['admin@folioria.jp', 'staff@folioria.jp'])

    // 审稿通过 → confirm → order_confirmed 通知下单客户
    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: 'approved' },
    })
    const confirmed = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'confirmed' },
    })
    expect(confirmed.statusCode).toBe(200)
    expect(logRows(db, 'order_confirmed').map((r) => r.recipient)).toEqual(['a@cust.example'])

    db.prepare(
      `UPDATE jobs SET status = 'done', completed_at = datetime('now')
       WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
    ).run(order.id)
    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'in_production' },
    })
    const ready = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'ready' },
    })
    expect(ready.statusCode).toBe(200)
    expect(logRows(db, 'order_ready').map((r) => r.recipient)).toEqual(['a@cust.example'])
  })

  it('邮件渠道 HTTP 全挂时业务流转照常（failed 留痕，状态推进成功）', async () => {
    vi.stubEnv('SPOOL_RESEND_API_KEY', 'test-key')
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')))

    const cookie = await login('a@cust.example')
    const order = await orderInReview(cookie)
    expect(
      (db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id) as { status: string }).status,
    ).toBe('file_pending')
    const rows = logRows(db, 'order_file_pending')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.status === 'failed')).toBe(true)
  })
})

describe('模板', () => {
  it('验证链接落 #/verify/:token，origin 取 SPOOL_PUBLIC_ORIGIN', () => {
    vi.stubEnv('SPOOL_PUBLIC_ORIGIN', 'https://www.folioria.com')
    expect(verificationLink('tok123')).toBe('https://www.folioria.com/#/verify/tok123')
    const msg = templates.emailVerification('tok123')
    expect(msg.text).toContain('https://www.folioria.com/#/verify/tok123')
  })
})
