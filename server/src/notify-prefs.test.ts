import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { notifyUser, templates } from './notify.js'
import { createTestUser, makeTestDb } from './test-helpers.js'

/** C3 通知偏好（仅 email channel）：GET/PATCH + 分发遵循 channels/addresses。 */

let db: DB
let app: App
let userId: string
beforeEach(() => {
  db = makeTestDb()
  spoolInit(db, { baseCurrency: 'JPY', adminEmail: 'admin@folioria.jp', adminName: 'K君', adminPassword: 'pw-initial-x' })
  userId = createTestUser(db, { email: 'a@cust.example' })
  app = buildApp(db)
})
afterEach(async () => {
  await app.close()
  db.close()
})

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
  const m = /spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))
  return `${SESSION_COOKIE}=${m?.[1]}`
}

const recipients = () =>
  (db.prepare('SELECT recipient FROM notification_log ORDER BY rowid').all() as Array<{ recipient: string }>).map((r) => r.recipient)
const clearLog = () => db.prepare('DELETE FROM notification_log').run()

describe('GET/PATCH /api/auth/notify-prefs', () => {
  it('默认 channels=[email]、addresses={}；分发落账号邮箱', async () => {
    const cookie = await login('a@cust.example')
    const res = await app.inject({ method: 'GET', url: '/api/auth/notify-prefs', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { channels: string[]; addresses: Record<string, string>; account_email: string }
    expect(body.channels).toEqual(['email'])
    expect(body.addresses).toEqual({})
    expect(body.account_email).toBe('a@cust.example')

    await notifyUser(db, 'order_ready', userId, templates.orderReady('FOL-1'))
    expect(recipients()).toEqual(['a@cust.example'])
  })

  it('覆盖收件邮箱 → 分发改投该地址', async () => {
    const cookie = await login('a@cust.example')
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/notify-prefs',
      headers: { cookie },
      payload: { addresses: { email: 'alt@inbox.example' } },
    })
    expect(res.statusCode).toBe(200)
    clearLog()
    await notifyUser(db, 'order_ready', userId, templates.orderReady('FOL-1'))
    expect(recipients()).toEqual(['alt@inbox.example'])
  })

  it('退订 email（channels=[]）→ 不分发任何渠道', async () => {
    const cookie = await login('a@cust.example')
    await app.inject({ method: 'PATCH', url: '/api/auth/notify-prefs', headers: { cookie }, payload: { channels: [] } })
    clearLog()
    await notifyUser(db, 'order_ready', userId, templates.orderReady('FOL-1'))
    expect(recipients()).toEqual([])
  })

  it('非法邮箱 → 422；未知渠道 → schema 422；未登录 → 401', async () => {
    const cookie = await login('a@cust.example')
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/auth/notify-prefs', headers: { cookie }, payload: { addresses: { email: 'not-an-email' } } })).statusCode,
    ).toBe(422)
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/auth/notify-prefs', headers: { cookie }, payload: { channels: ['sms'] } })).statusCode,
    ).toBe(422)
    expect((await app.inject({ method: 'GET', url: '/api/auth/notify-prefs' })).statusCode).toBe(401)
  })
})
