import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { verifyLogin } from './auth.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { collectForbiddenKeys, createTestUser, makeTestDb } from './test-helpers.js'

const ADMIN = { email: 'admin@folioria.jp', password: 'initial-secret-pw' }

let db: DB
let app: App
beforeEach(() => {
  db = makeTestDb()
  spoolInit(db, {
    baseCurrency: 'JPY',
    adminEmail: ADMIN.email,
    adminName: 'K君',
    adminPassword: ADMIN.password,
  })
  app = buildApp(db)
})
afterEach(async () => {
  await app.close()
  db.close()
})

async function login(email: string, password: string): Promise<{ cookie: string; body: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  const match = /spool_session=([^;]+)/.exec(raw ?? '')
  expect(match).not.toBeNull()
  return { cookie: `${SESSION_COOKIE}=${match?.[1]}`, body: res.json() }
}

describe('登录/登出', () => {
  it('错误密码与未知邮箱同样 401（不泄露存在性）', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: 'wrong' },
    })
    const ghost = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@x.jp', password: 'wrong' },
    })
    expect(bad.statusCode).toBe(401)
    expect(ghost.statusCode).toBe(401)
    expect(bad.json()).toEqual(ghost.json())
  })

  it('登录成功：httpOnly cookie + 用户 DTO（不含 password_hash）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: ADMIN.password },
    })
    expect(res.statusCode).toBe(200)
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    const body = res.json() as Record<string, unknown>
    expect(body['role']).toBe('admin')
    expect(body['must_change_password']).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/password_hash/)
  })

  it('session 表只存 sha256(token)，不存明文', async () => {
    const { cookie } = await login(ADMIN.email, ADMIN.password)
    const token = cookie.split('=')[1] ?? ''
    const stored = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }
    expect(stored.token_hash).not.toBe(token)
    expect(stored.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
  })

  it('登出吊销 session，me 立即 401', async () => {
    const { cookie } = await login(ADMIN.email, ADMIN.password)
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200)
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
    ).toBe(401)
    const revoked = db.prepare('SELECT revoked_at FROM sessions').get() as {
      revoked_at: string | null
    }
    expect(revoked.revoked_at).not.toBeNull()
  })
})

describe('S2 登录恒时比对', () => {
  it('未知邮箱与已知邮箱同样执行一次 bcrypt 比对（消除计时侧信道）', () => {
    const spy = vi.spyOn(bcrypt, 'compareSync')
    try {
      expect(verifyLogin(db, 'ghost@nowhere.jp', 'whatever')).toBeNull()
      expect(spy).toHaveBeenCalledTimes(1)

      spy.mockClear()
      expect(verifyLogin(db, ADMIN.email, 'wrong-password')).toBeNull()
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('首登强制改密（D11）', () => {
  it('flag 未清前管理域 403 password_change_required；改密后放行且 flag 清零', async () => {
    const { cookie } = await login(ADMIN.email, ADMIN.password)

    const blocked = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })
    expect(blocked.statusCode).toBe(403)
    expect((blocked.json() as { error: string }).error).toBe('password_change_required')

    const wrongOld = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { old_password: 'nope', new_password: 'fresh-new-password' },
    })
    expect(wrongOld.statusCode).toBe(401)

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { old_password: ADMIN.password, new_password: 'fresh-new-password' },
    })
    expect(ok.statusCode).toBe(204)

    const allowed = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })
    expect(allowed.statusCode).toBe(200)

    const flag = db
      .prepare('SELECT must_change_password FROM users WHERE email = ?')
      .get(ADMIN.email) as { must_change_password: number }
    expect(flag.must_change_password).toBe(0)
  })
})

describe('§6 权限（双域）', () => {
  it('Phase 1 注册通道不存在 → 404（admin 自注册同理）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'x@y.z', password: 'whatever-12345' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('guest 调用管理域 → 401；member/customer → 403', async () => {
    createTestUser(db, { email: 'member@folioria.jp', role: 'member' })
    createTestUser(db, { email: 'cust@folioria.jp', role: 'customer' })

    expect((await app.inject({ method: 'GET', url: '/api/admin/users' })).statusCode).toBe(401)

    const member = await login('member@folioria.jp', 'test-password')
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: member.cookie } }))
        .statusCode,
    ).toBe(403)

    const cust = await login('cust@folioria.jp', 'test-password')
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: cust.cookie } }))
        .statusCode,
    ).toBe(403)
  })

  it('下单域端点响应深度遍历：无 cost/profit/margin 键', async () => {
    const { cookie, body } = await login(ADMIN.email, ADMIN.password)
    expect(collectForbiddenKeys(body)).toEqual([])
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(collectForbiddenKeys(me.json())).toEqual([])
  })
})

describe('管理域用户管理（B1 账号供给）', () => {
  let adminCookie: string
  beforeEach(async () => {
    const { cookie } = await login(ADMIN.email, ADMIN.password)
    await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { old_password: ADMIN.password, new_password: 'fresh-new-password' },
    })
    adminCookie = cookie
  })

  it('admin 创建用户、member 升格、重复邮箱 409', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: { email: 'neko@202.jp', name: '猫', password: 'resident-pass-1', role: 'customer' },
    })
    expect(created.statusCode).toBe(201)
    const id = (created.json() as { id: string }).id

    const upgraded = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${id}`,
      headers: { cookie: adminCookie },
      payload: { role: 'member' },
    })
    expect(upgraded.statusCode).toBe(200)
    expect((upgraded.json() as { role: string }).role).toBe('member')

    const dup = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: { email: 'NEKO@202.jp', name: 'x', password: 'resident-pass-2', role: 'customer' },
    })
    expect(dup.statusCode).toBe(409)
  })

  it('S3: admin 创建的用户初始密码一次性（must_change_password=1，改密后清零）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: { email: 'fresh@202.jp', name: '新人', password: 'initial-pass-1', role: 'customer' },
    })
    expect(created.statusCode).toBe(201)
    expect((created.json() as { must_change_password: boolean }).must_change_password).toBe(true)

    const flag = db
      .prepare('SELECT must_change_password FROM users WHERE email = ?')
      .get('fresh@202.jp') as { must_change_password: number }
    expect(flag.must_change_password).toBe(1)

    const { cookie } = await login('fresh@202.jp', 'initial-pass-1')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect((me.json() as { must_change_password: boolean }).must_change_password).toBe(true)

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { old_password: 'initial-pass-1', new_password: 'my-own-password' },
    })
    expect(changed.statusCode).toBe(204)
    const cleared = db
      .prepare('SELECT must_change_password FROM users WHERE email = ?')
      .get('fresh@202.jp') as { must_change_password: number }
    expect(cleared.must_change_password).toBe(0)
  })

  it('S1: 最后一个活跃 admin 不可归档/降格 → 409 last_admin', async () => {
    const adminId = (db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN.email) as { id: string }).id

    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { role: 'member' },
    })
    expect(demote.statusCode).toBe(409)
    expect((demote.json() as { error: string }).error).toBe('last_admin')

    const archive = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { archived: true },
    })
    expect(archive.statusCode).toBe(409)

    // 已归档的 admin 不算活跃，不解除保护
    const ghostId = createTestUser(db, { email: 'old-admin@folioria.jp', role: 'admin' })
    db.prepare('UPDATE users SET archived = 1 WHERE id = ?').run(ghostId)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/admin/users/${adminId}`,
          headers: { cookie: adminCookie },
          payload: { archived: true },
        })
      ).statusCode,
    ).toBe(409)

    // 第二个活跃 admin 出现后降格放行；非降格 PATCH（role 仍 admin）始终放行
    createTestUser(db, { email: 'admin2@folioria.jp', role: 'admin' })
    const keep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { role: 'admin' },
    })
    expect(keep.statusCode).toBe(200)
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { role: 'member' },
    })
    expect(ok.statusCode).toBe(200)
  })
})

describe('限流（PRD §6：/api/auth/* 按 IP，键取 CF-Connecting-IP）', () => {
  it('登录暴力尝试第 11 次 → 429；其他 IP 不受牵连', async () => {
    const attacker = { 'cf-connecting-ip': '203.0.113.7' }
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'ghost@x.jp', password: 'wrong' },
        headers: attacker,
      })
      expect(r.statusCode).toBe(401)
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@x.jp', password: 'wrong' },
      headers: attacker,
    })
    expect(blocked.statusCode).toBe(429)

    const bystander = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@x.jp', password: 'wrong' },
      headers: { 'cf-connecting-ip': '203.0.113.99' },
    })
    expect(bystander.statusCode).toBe(401)
  })
})

describe('§7 schema 校验边界', () => {
  it('登录 body 缺字段 / 类型错 → 422', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })
    expect(missing.statusCode).toBe(422)
    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.c', password: 123 },
    })
    expect(wrongType.statusCode).toBe(422)
  })
})
