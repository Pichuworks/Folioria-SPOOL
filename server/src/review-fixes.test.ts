import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

// 覆盖 code review 修复中此前无自动化测试的两条防护：CSRF 头校验（L-CSRF）与切币下单守卫（M8）。

let db: DB
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
})
afterEach(() => {
  db.close()
})

const A4_ITEM = { mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }

async function login(app: App, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-spool-request': '1' },
    payload: { email, password: 'test-password' },
  })
  expect(res.statusCode).toBe(200)
  const m = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
  return `${SESSION_COOKIE}=${m?.[1]}`
}

describe('review L-CSRF：enforceCsrf 开启时校验 X-SPOOL-Request 头', () => {
  it('缺头的状态变更请求 → 403 csrf_rejected；带头则放行（不再被 CSRF 拦）', async () => {
    const app = buildApp(db, { enforceCsrf: true })
    try {
      const noHeader = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'a@cust.example', password: 'test-password' },
      })
      expect(noHeader.statusCode).toBe(403)
      expect(noHeader.json()).toMatchObject({ error: 'csrf_rejected' })

      const withHeader = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-spool-request': '1' },
        payload: { email: 'a@cust.example', password: 'test-password' },
      })
      expect(withHeader.statusCode).not.toBe(403)
    } finally {
      await app.close()
    }
  })
})

describe('review M8：pricing_needs_reentry 置位时拒绝下单', () => {
  it('flag=1 → POST /api/orders 409 pricing_reentry_required；flag=0 正常 201', async () => {
    const app = buildApp(db)
    try {
      const cookie = await login(app, 'a@cust.example')

      db.prepare('UPDATE system_config SET pricing_needs_reentry = 1 WHERE id = 1').run()
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { cookie },
        payload: { items: [A4_ITEM] },
      })
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json()).toMatchObject({ error: 'pricing_reentry_required' })

      db.prepare('UPDATE system_config SET pricing_needs_reentry = 0 WHERE id = 1').run()
      const ok = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { cookie },
        payload: { items: [A4_ITEM] },
      })
      expect(ok.statusCode).toBe(201)
    } finally {
      await app.close()
    }
  })
})
