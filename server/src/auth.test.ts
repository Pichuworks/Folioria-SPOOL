import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { issueEmailVerification, issuePasswordReset, verifyLogin } from './auth.js'
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

describe('S6 cookie secure 配置化', () => {
  it('默认 Secure；cookieSecure:false 时不带（明文 HTTP 调试场景，生产禁用）', async () => {
    const secure = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: ADMIN.password },
    })
    expect(String(secure.headers['set-cookie'])).toMatch(/;\s*Secure/i)

    const plainApp = buildApp(db, { cookieSecure: false })
    try {
      const plain = await plainApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: ADMIN.email, password: ADMIN.password },
      })
      expect(plain.statusCode).toBe(200)
      expect(String(plain.headers['set-cookie'])).not.toMatch(/;\s*Secure/i)
    } finally {
      await plainApp.close()
    }
  })
})

describe('S2 登录恒时比对', () => {
  it('未知邮箱与已知邮箱同样执行一次 bcrypt 比对（消除计时侧信道）', async () => {
    const spy = vi.spyOn(bcrypt, 'compare')
    try {
      expect(await verifyLogin(db, 'ghost@nowhere.jp', 'whatever')).toBeNull()
      expect(spy).toHaveBeenCalledTimes(1)

      spy.mockClear()
      expect(await verifyLogin(db, ADMIN.email, 'wrong-password')).toBeNull()
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
  it('register 存在但 role 恒 customer；admin 自注册通道不存在 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'x@y.example', name: 'X', password: 'whatever-12345' },
    })
    expect(res.statusCode).toBe(201)
    const role = (db.prepare('SELECT role FROM users WHERE email = ?').get('x@y.example') as { role: string }).role
    expect(role).toBe('customer')

    // payload 试图自带 role → body 白名单剥除（ajv removeAdditional），落库仍恒 customer
    const withRole = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'evil@y.example', name: 'X', password: 'whatever-12345', role: 'admin' },
    })
    expect(withRole.statusCode).toBe(201)
    expect(
      (db.prepare('SELECT role FROM users WHERE email = ?').get('evil@y.example') as { role: string }).role,
    ).toBe('customer')

    // admin 自注册通道不存在
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/register-admin',
          payload: { email: 'a@y.example', name: 'X', password: 'whatever-12345' },
        })
      ).statusCode,
    ).toBe(404)
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

describe('R4 下单域开放注册 + 邮箱验证（D10/D12）', () => {
  const REG = { email: 'neko@202.example', name: '猫', password: 'resident-pass-1' }

  it('注册成功：201 + role customer + 即登录 cookie + 未验证标记 + 不置 must_change_password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: REG })
    expect(res.statusCode).toBe(201)
    expect(String(res.headers['set-cookie'])).toMatch(/spool_session=/)
    const body = res.json() as Record<string, unknown>
    expect(body['role']).toBe('customer')
    expect(body['email_verified']).toBe(false)
    expect(body['must_change_password']).toBe(false)
    expect(collectForbiddenKeys(body)).toEqual([])

    const row = db
      .prepare('SELECT role, must_change_password, email_verified_at FROM users WHERE email = ?')
      .get(REG.email) as { role: string; must_change_password: number; email_verified_at: string | null }
    expect(row.role).toBe('customer')
    expect(row.must_change_password).toBe(0)
    expect(row.email_verified_at).toBeNull()
  })

  it('重复邮箱（大小写不敏感）→ 409', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: REG })
    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...REG, email: 'NEKO@202.example' },
    })
    expect(dup.statusCode).toBe(409)
    expect((dup.json() as { error: string }).error).toBe('email_exists')
  })

  it('registration_open=0 → 403 registration_closed', async () => {
    db.prepare('UPDATE system_config SET registration_open = 0 WHERE id = 1').run()
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: REG })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: string }).error).toBe('registration_closed')
  })

  it('invite_code 开启：缺码/错码 403，对码成功（D10 邀请码开关）', async () => {
    db.prepare("UPDATE system_config SET invite_code = 'FOLIO-2026' WHERE id = 1").run()
    const noCode = await app.inject({ method: 'POST', url: '/api/auth/register', payload: REG })
    expect(noCode.statusCode).toBe(403)
    expect((noCode.json() as { error: string }).error).toBe('invalid_invite_code')

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...REG, invite_code: 'WRONG' },
    })
    expect(wrong.statusCode).toBe(403)

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...REG, invite_code: 'FOLIO-2026' },
    })
    expect(ok.statusCode).toBe(201)
  })

  it('邮箱验证：token 一次性消费置位 email_verified_at；复用/伪造 404', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: REG })
    const userId = (reg.json() as { id: string }).id
    const token = issueEmailVerification(db, userId)
    // token 仅存哈希
    const stored = db.prepare('SELECT token_hash FROM email_verification_tokens').all() as Array<{
      token_hash: string
    }>
    expect(stored.some((r) => r.token_hash === token)).toBe(false)

    const ok = await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token } })
    expect(ok.statusCode).toBe(204)
    const row = db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(userId) as {
      email_verified_at: string | null
    }
    expect(row.email_verified_at).not.toBeNull()

    // 复用 → 404；伪造 → 404（不泄露存在性）
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token } })).statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: 'bogus' } })
      ).statusCode,
    ).toBe(404)
  })

  it('过期 token → 404', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: REG })
    const userId = (reg.json() as { id: string }).id
    const token = issueEmailVerification(db, userId)
    db.prepare("UPDATE email_verification_tokens SET expires_at = '2020-01-01T00:00:00Z'").run()
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token } })).statusCode,
    ).toBe(404)
  })

  it('限流：同 IP 第 11 次注册 → 429（同 auth 口径 10/5min）', async () => {
    const attacker = { 'cf-connecting-ip': '203.0.113.50' }
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { ...REG, email: `r${i}@202.example` },
        headers: attacker,
      })
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...REG, email: 'r11@202.example' },
      headers: attacker,
    })
    expect(blocked.statusCode).toBe(429)
  })

  it('admin 手动建号视为已验证（D12：admin 供给的账号不走邮箱验证）', async () => {
    const { cookie } = await login(ADMIN.email, ADMIN.password)
    await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { old_password: ADMIN.password, new_password: 'fresh-new-password' },
    })
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: { email: 'manual@202.example', name: '手动', password: 'initial-pass-1', role: 'customer' },
    })
    expect(created.statusCode).toBe(201)
    const row = db.prepare('SELECT email_verified_at FROM users WHERE email = ?').get('manual@202.example') as {
      email_verified_at: string | null
    }
    expect(row.email_verified_at).not.toBeNull()
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

describe('账号资料 PATCH /api/auth/profile', () => {
  it('改称呼/联系方式落库并回显；guest 401', async () => {
    createTestUser(db, { email: 'p@cust.example', name: '旧名' })
    const { cookie } = await login('p@cust.example', 'test-password')
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/profile',
      headers: { cookie },
      payload: { name: '新名', contact_info: 'LINE: neko' },
    })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { name: string; contact_info: string | null }
    expect(dto.name).toBe('新名')
    expect(dto.contact_info).toBe('LINE: neko')
    const row = db.prepare('SELECT name, contact_info FROM users WHERE email = ?').get('p@cust.example') as {
      name: string
      contact_info: string | null
    }
    expect(row).toEqual({ name: '新名', contact_info: 'LINE: neko' })
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/auth/profile', payload: { name: 'x' } })).statusCode,
    ).toBe(401)
  })
})

describe('D19 忘记密码 / 重置', () => {
  it('forgot 对存在账号建 token、对未知账号不建（皆 204 不泄露存在性）', async () => {
    const uid = createTestUser(db, { email: 'reset@cust.example' })
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/forgot-password',
          payload: { identifier: 'reset@cust.example' },
        })
      ).statusCode,
    ).toBe(204)
    expect(
      (db.prepare('SELECT COUNT(*) n FROM password_reset_tokens WHERE user_id = ?').get(uid) as { n: number }).n,
    ).toBe(1)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/forgot-password',
          payload: { identifier: 'ghost@nope.example' },
        })
      ).statusCode,
    ).toBe(204)
    // 未知账号不建 token
    expect((db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').get() as { n: number }).n).toBe(1)
  })

  it('reset：有效 token 改密、吊销旧会话、新密码可登录；token 一次性 + 坏 token 404', async () => {
    const uid = createTestUser(db, { email: 'reset2@cust.example', password: 'old-password-1' })
    const { cookie } = await login('reset2@cust.example', 'old-password-1')
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200)

    const token = issuePasswordReset(db, uid)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token, new_password: 'brand-new-pass-9' },
        })
      ).statusCode,
    ).toBe(204)
    // 旧会话被吊销
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401)
    // 新密码可登录、旧密码失败
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { identifier: 'reset2@cust.example', password: 'brand-new-pass-9' },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { identifier: 'reset2@cust.example', password: 'old-password-1' },
        })
      ).statusCode,
    ).toBe(401)
    // token 一次性 + 坏 token → 404
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token, new_password: 'another-pass-9' },
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token: 'garbage-token', new_password: 'another-pass-9' },
        })
      ).statusCode,
    ).toBe(404)
  })
})

describe('D18 用户名登录', () => {
  const REG = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: body })

  it('注册可设用户名，并可用用户名（大小写不敏感）登录', async () => {
    const reg = await REG({ email: 'neko@cust.example', username: 'neko_print', name: '猫', password: 'a-good-password' })
    expect(reg.statusCode).toBe(201)
    expect((reg.json() as { username: string }).username).toBe('neko_print')
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'NEKO_PRINT', password: 'a-good-password' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { email: string }).email).toBe('neko@cust.example')
  })

  it('用户名被占用 → 409 username_taken；NOCASE 索引拒绝异样大小写重名', async () => {
    expect(
      (await REG({ email: 'a1@cust.example', username: 'shared', name: 'A', password: 'a-good-password' })).statusCode,
    ).toBe(201)
    const dup = await REG({ email: 'a2@cust.example', username: 'shared', name: 'B', password: 'a-good-password' })
    expect(dup.statusCode).toBe(409)
    expect((dup.json() as { error: string }).error).toBe('username_taken')
    // 索引 COLLATE NOCASE 在列上生效：直插异样大小写也冲突
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (id, email, username, password_hash, name, role, created_at) VALUES ('u-caps','caps@x.jp','SHARED','h','C','customer','2026-06-10T00:00:00Z')",
        )
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('用户名格式非法（空格 / 过短）→ 422', async () => {
    expect(
      (await REG({ email: 'b@cust.example', username: 'Has Space', name: 'B', password: 'a-good-password' })).statusCode,
    ).toBe(422)
    expect(
      (await REG({ email: 'c@cust.example', username: 'ab', name: 'C', password: 'a-good-password' })).statusCode,
    ).toBe(422)
  })
})
