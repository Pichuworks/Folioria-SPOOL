import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

/**
 * PC1 审计扩面：定价/配置编辑、mode/paper/size 编辑、订单 confirm/cancel、用户创建一并落 admin_audit。
 * PC2 取消含已收款：cancel 不自动退款，响应 refund_due = paid_amount，cancel 审计摘要附「须退」。
 */

let db: DB
let app: App

beforeEach(() => {
  db = makeTestDb()
  spoolInit(db, { baseCurrency: 'JPY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'initial-secret-pw' })
  importSeed(db)
  createTestUser(db, { email: 'a@cust.example' })
  createTestUser(db, { email: 'staff@folioria.jp', role: 'admin' })
  app = buildApp(db)
})
afterEach(async () => {
  await app.close()
  db.close()
})

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
  const match = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
  return `${SESSION_COOKIE}=${match?.[1]}`
}

async function auditActions(admin: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { cookie: admin } })
  return (res.json() as Array<{ action: string }>).map((r) => r.action)
}

describe('PC1 定价/配置编辑审计扩面', () => {
  it('mode/paper/size + 书成品/组件/工艺编辑各落 pricing.* 审计', async () => {
    const admin = await login('staff@folioria.jp')
    await app.inject({ method: 'PATCH', url: '/api/pricing/modes/1', headers: { cookie: admin }, payload: { ink_price_c: 99 } })
    await app.inject({ method: 'PATCH', url: '/api/pricing/papers/1', headers: { cookie: admin }, payload: { notes: '测试' } })
    await app.inject({ method: 'POST', url: '/api/pricing/sizes', headers: { cookie: admin }, payload: { key: 'ZZ', label: '测试尺寸', area: 1 } })
    const bookRes = await app.inject({ method: 'POST', url: '/api/pricing/books', headers: { cookie: admin }, payload: { name: '审计写真集' } })
    const bookId = (bookRes.json() as { id: number }).id
    await app.inject({
      method: 'POST',
      url: `/api/pricing/books/${bookId}/components`,
      headers: { cookie: admin },
      payload: { role: 'inner', paper_id: 1, size_key: 'A4', color_class: 'bw' },
    })
    await app.inject({ method: 'POST', url: '/api/pricing/finishings', headers: { cookie: admin }, payload: { name: '骑马钉', pricing: 'per_book', price_c: 2000 } })

    const actions = await auditActions(admin)
    expect(actions).toContain('pricing.mode')
    expect(actions).toContain('pricing.paper')
    expect(actions).toContain('pricing.size')
    expect(actions).toContain('pricing.book')
    expect(actions).toContain('pricing.book_component')
    expect(actions).toContain('pricing.finishing')
  })
})

describe('PC1 用户创建 + 订单状态流转审计', () => {
  it('POST /api/admin/users 落 user.create', async () => {
    const admin = await login('staff@folioria.jp')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: admin },
      payload: { email: 'new@staff.jp', name: '新成员', password: 'initial-pass-1', role: 'member' },
    })
    expect(res.statusCode).toBe(201)
    const actions = await auditActions(admin)
    expect(actions).toContain('user.create')
    const rows = (await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { cookie: admin } })).json() as Array<{
      action: string
      summary: string
    }>
    expect(rows.find((r) => r.action === 'user.create')!.summary).toContain('new@staff.jp')
  })

  it('confirm 落 order.confirm；cancel 落 order.cancel', async () => {
    const admin = await login('staff@folioria.jp')
    const cust = await login('a@cust.example')
    // 书单：DB 捷径推进到 file_approved 后 confirm（避开文件上传）
    const bookId = Number(db.prepare("INSERT INTO book_products (name) VALUES ('审计册')").run().lastInsertRowid)
    db.prepare(
      "INSERT INTO book_components (book_id, role, paper_id, size_key, color_class, duplex, sort) VALUES (?, 'inner', 1, 'A4', 'bw', 0, 0)",
    ).run(bookId)
    const innerId = (db.prepare('SELECT id FROM book_components WHERE book_id = ?').get(bookId) as { id: number }).id
    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: cust },
      payload: { books: [{ book_id: bookId, count: 2, components: [{ component_id: innerId, sheets_per_book: 5 }] }] },
    })
    const id = (created.json() as { id: string }).id
    db.prepare(
      `UPDATE order_book_components SET file_url = 'seed.pdf', file_status = 'approved'
       WHERE order_book_id IN (SELECT id FROM order_books WHERE order_id = ?)`,
    ).run(id)
    db.prepare("UPDATE orders SET status = 'file_approved' WHERE id = ?").run(id)

    await app.inject({ method: 'PATCH', url: `/api/orders/${id}/status`, headers: { cookie: admin }, payload: { status: 'confirmed' } })
    await app.inject({ method: 'PATCH', url: `/api/orders/${id}/status`, headers: { cookie: admin }, payload: { status: 'cancelled' } })

    const actions = await auditActions(admin)
    expect(actions).toContain('order.confirm')
    expect(actions).toContain('order.cancel')
  })
})

describe('PC2 取消含已收款：refund_due 提示 + 审计须退', () => {
  it('已收款订单取消：响应 refund_due = paid_amount，cancel 审计摘要含「须退」', async () => {
    const admin = await login('staff@folioria.jp')
    const cust = await login('a@cust.example')
    const order = (
      await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: cust }, payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }] } })
    ).json() as { id: string } // total 14
    // 收定金 10
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payments`, headers: { cookie: admin }, payload: { kind: 'deposit', amount: 10, method: '现金' } })

    const cancelled = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: admin },
      payload: { status: 'cancelled' },
    })
    expect(cancelled.statusCode).toBe(200)
    const body = cancelled.json() as { status: string; paid_amount: number; refund_due: number; refund_due_display: string }
    expect(body.status).toBe('cancelled')
    expect(body.paid_amount).toBe(10) // 取消不自动退款，已收不变
    expect(body.refund_due).toBe(10)
    expect(body.refund_due_display).toBe('¥10')

    const rows = (await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { cookie: admin } })).json() as Array<{
      action: string
      summary: string
    }>
    expect(rows.find((r) => r.action === 'order.cancel')!.summary).toContain('须退')
  })

  it('未收款订单取消：refund_due = 0', async () => {
    const admin = await login('staff@folioria.jp')
    const cust = await login('a@cust.example')
    const order = (
      await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: cust }, payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }] } })
    ).json() as { id: string }
    const cancelled = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: admin },
      payload: { status: 'cancelled' },
    })
    const body = cancelled.json() as { refund_due: number }
    expect(body.refund_due).toBe(0)
  })

  it('下单域（customer）不暴露 refund_due', async () => {
    const cust = await login('a@cust.example')
    const order = (
      await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: cust }, payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }] } })
    ).json() as { id: string }
    await app.inject({ method: 'PATCH', url: `/api/orders/${order.id}/status`, headers: { cookie: cust }, payload: { status: 'cancelled' } })
    const view = await app.inject({ method: 'GET', url: `/api/orders/${order.id}`, headers: { cookie: cust } })
    expect(view.json()).not.toHaveProperty('refund_due')
  })
})
