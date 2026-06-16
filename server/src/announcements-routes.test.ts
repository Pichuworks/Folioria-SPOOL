import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { importSeed } from './seed.js'
import { createTestUser, makeTestDb, withSystemConfig } from './test-helpers.js'

let db: DB
let app: App
let adminCookie: string
let memberCookie: string
let customerCookie: string

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password' } })
  return `${SESSION_COOKIE}=${/spool_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1]}`
}

interface AnnDto {
  id: string
  title: string
  body: string
  audience: string
  pinned: boolean
  published_at: string | null
  expires_at: string | null
  author_id: string
  archived: boolean
  created_at: string
  updated_at: string
  author_name?: string | null
}

async function createAnn(
  overrides: Record<string, unknown> = {},
): Promise<AnnDto> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/announcements',
    headers: { cookie: adminCookie },
    payload: { title: '测试公告', body: '内容', ...overrides },
  })
  expect(res.statusCode).toBe(201)
  return res.json() as AnnDto
}

beforeEach(async () => {
  db = makeTestDb()
  withSystemConfig(db)
  importSeed(db)
  createTestUser(db, { email: 'admin@t.jp', role: 'admin' })
  createTestUser(db, { email: 'member@t.jp', role: 'member' })
  createTestUser(db, { email: 'customer@t.jp', role: 'customer' })
  app = buildApp(db)
  adminCookie = await login('admin@t.jp')
  memberCookie = await login('member@t.jp')
  customerCookie = await login('customer@t.jp')
})
afterEach(async () => {
  await app.close()
  db.close()
})

// ── 鉴权 ───────────────────────────────────────────────────────

describe('鉴权', () => {
  it('admin 端点：guest 401 / customer 403 / member 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/announcements' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/admin/announcements', headers: { cookie: customerCookie } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/admin/announcements', headers: { cookie: memberCookie } })).statusCode).toBe(403)
  })

  it('下单域端点：guest 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/announcements' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/announcements/unread-count' })).statusCode).toBe(401)
  })

  it('公开端点：guest 可访问', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/public-announcements' })).statusCode).toBe(200)
  })
})

// ── CRUD 生命周期 ──────────────────────────────────────────────

describe('CRUD 生命周期', () => {
  it('创建草稿 → 编辑 → 发布 → 归档', async () => {
    const draft = await createAnn()
    expect(draft.published_at).toBeNull()
    expect(draft.archived).toBe(false)

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/admin/announcements/${draft.id}`,
      headers: { cookie: adminCookie },
      payload: { title: '改标题', body: '改内容' },
    })
    expect(edited.statusCode).toBe(200)
    expect((edited.json() as AnnDto).title).toBe('改标题')

    const published = await app.inject({
      method: 'PATCH',
      url: `/api/admin/announcements/${draft.id}`,
      headers: { cookie: adminCookie },
      payload: { published_at: new Date().toISOString() },
    })
    expect(published.statusCode).toBe(200)
    expect((published.json() as AnnDto).published_at).not.toBeNull()

    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/admin/announcements/${draft.id}/archive`,
      headers: { cookie: adminCookie },
    })
    expect(archived.statusCode).toBe(204)

    const list = await app.inject({ method: 'GET', url: '/api/admin/announcements', headers: { cookie: adminCookie } })
    expect((list.json() as AnnDto[])[0]!.archived).toBe(true)
  })

  it('创建时 publish: true 直接发布', async () => {
    const ann = await createAnn({ publish: true })
    expect(ann.published_at).not.toBeNull()
  })

  it('PATCH 不存在的 id → 404', async () => {
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/admin/announcements/ghost', headers: { cookie: adminCookie }, payload: { title: 'x' } })).statusCode,
    ).toBe(404)
  })

  it('归档不存在的 id → 404；重复归档 → 409', async () => {
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/admin/announcements/ghost/archive', headers: { cookie: adminCookie } })).statusCode,
    ).toBe(404)

    const ann = await createAnn()
    await app.inject({ method: 'PATCH', url: `/api/admin/announcements/${ann.id}/archive`, headers: { cookie: adminCookie } })
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/admin/announcements/${ann.id}/archive`, headers: { cookie: adminCookie } })).statusCode,
    ).toBe(409)
  })

  it('管理域列表含草稿和已归档', async () => {
    await createAnn({ title: '草稿' })
    const pub = await createAnn({ title: '已发布', publish: true })
    const arch = await createAnn({ title: '归档' })
    await app.inject({ method: 'PATCH', url: `/api/admin/announcements/${arch.id}/archive`, headers: { cookie: adminCookie } })

    const list = await app.inject({ method: 'GET', url: '/api/admin/announcements', headers: { cookie: adminCookie } })
    const titles = (list.json() as AnnDto[]).map((a) => a.title)
    expect(titles).toContain('草稿')
    expect(titles).toContain('已发布')
    expect(titles).toContain('归档')
  })
})

// ── 422 校验 ────────────────────────────────────────────────────

describe('422 校验', () => {
  it('空标题 → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: { cookie: adminCookie },
      payload: { title: '' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('非法 audience → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: { cookie: adminCookie },
      payload: { title: '测试', audience: 'nobody' },
    })
    expect(res.statusCode).toBe(422)
  })
})

// ── audience 过滤 ──────────────────────────────────────────────

describe('audience 过滤', () => {
  beforeEach(async () => {
    await createAnn({ title: 'PUBLIC', audience: 'public', publish: true })
    await createAnn({ title: 'ALL', audience: 'all', publish: true })
    await createAnn({ title: 'CUSTOMERS', audience: 'customers', publish: true })
    await createAnn({ title: 'STAFF', audience: 'staff', publish: true })
  })

  it('customer 看到 public + all + customers，看不到 staff', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/announcements', headers: { cookie: customerCookie } })
    const titles = (res.json() as Array<{ title: string }>).map((a) => a.title)
    expect(titles).toContain('PUBLIC')
    expect(titles).toContain('ALL')
    expect(titles).toContain('CUSTOMERS')
    expect(titles).not.toContain('STAFF')
  })

  it('member 看到 public + all + staff，看不到 customers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/announcements', headers: { cookie: memberCookie } })
    const titles = (res.json() as Array<{ title: string }>).map((a) => a.title)
    expect(titles).toContain('PUBLIC')
    expect(titles).toContain('ALL')
    expect(titles).toContain('STAFF')
    expect(titles).not.toContain('CUSTOMERS')
  })

  it('admin 看到 public + all + staff，看不到 customers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/announcements', headers: { cookie: adminCookie } })
    const titles = (res.json() as Array<{ title: string }>).map((a) => a.title)
    expect(titles).toContain('PUBLIC')
    expect(titles).toContain('ALL')
    expect(titles).toContain('STAFF')
    expect(titles).not.toContain('CUSTOMERS')
  })

  it('公开端点只返回 audience=public', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public-announcements' })
    const titles = (res.json() as Array<{ title: string }>).map((a) => a.title)
    expect(titles).toEqual(['PUBLIC'])
  })
})

// ── 草稿 / 过期不可见 ─────────────────────────────────────────

describe('草稿 / 过期不可见', () => {
  it('草稿对非 admin 不可见', async () => {
    await createAnn({ title: '草稿', audience: 'all' })
    await createAnn({ title: '已发布', audience: 'all', publish: true })

    const res = await app.inject({ method: 'GET', url: '/api/announcements', headers: { cookie: customerCookie } })
    const titles = (res.json() as Array<{ title: string }>).map((a) => a.title)
    expect(titles).toContain('已发布')
    expect(titles).not.toContain('草稿')
  })

  it('过期公告对非 admin 不可见', async () => {
    await createAnn({
      title: '过期',
      audience: 'all',
      publish: true,
      expires_at: '2020-01-01T00:00:00Z',
    })
    await createAnn({ title: '未过期', audience: 'all', publish: true })

    const res = await app.inject({ method: 'GET', url: '/api/announcements', headers: { cookie: customerCookie } })
    const titles = (res.json() as Array<{ title: string }>).map((a) => a.title)
    expect(titles).toContain('未过期')
    expect(titles).not.toContain('过期')
  })

  it('归档公告对非 admin 不可见', async () => {
    const ann = await createAnn({ title: '归档', audience: 'all', publish: true })
    await app.inject({ method: 'PATCH', url: `/api/admin/announcements/${ann.id}/archive`, headers: { cookie: adminCookie } })

    const res = await app.inject({ method: 'GET', url: '/api/announcements', headers: { cookie: customerCookie } })
    const titles = (res.json() as Array<{ title: string }>).map((a) => a.title)
    expect(titles).not.toContain('归档')
  })
})

// ── pinned 互斥 ────────────────────────────────────────────────

describe('pinned 互斥', () => {
  it('新 pin 自动取消旧 pin', async () => {
    const a = await createAnn({ title: 'A', pinned: true, publish: true })
    const b = await createAnn({ title: 'B', pinned: true, publish: true })

    const list = await app.inject({ method: 'GET', url: '/api/admin/announcements', headers: { cookie: adminCookie } })
    const items = list.json() as AnnDto[]
    expect(items.find((i) => i.id === a.id)!.pinned).toBe(false)
    expect(items.find((i) => i.id === b.id)!.pinned).toBe(true)
  })

  it('PATCH pin 也触发互斥', async () => {
    const a = await createAnn({ title: 'A', pinned: true, publish: true })
    const b = await createAnn({ title: 'B', publish: true })

    await app.inject({
      method: 'PATCH',
      url: `/api/admin/announcements/${b.id}`,
      headers: { cookie: adminCookie },
      payload: { pinned: true },
    })

    const list = await app.inject({ method: 'GET', url: '/api/admin/announcements', headers: { cookie: adminCookie } })
    const items = list.json() as AnnDto[]
    expect(items.find((i) => i.id === a.id)!.pinned).toBe(false)
    expect(items.find((i) => i.id === b.id)!.pinned).toBe(true)
  })
})

// ── 已读追踪 ───────────────────────────────────────────────────

describe('已读追踪', () => {
  it('mark read → is_read=true + unread count 减 1；幂等', async () => {
    const a = await createAnn({ audience: 'all', publish: true })
    const b = await createAnn({ audience: 'all', publish: true })

    const count0 = await app.inject({ method: 'GET', url: '/api/announcements/unread-count', headers: { cookie: customerCookie } })
    expect((count0.json() as { count: number }).count).toBe(2)

    const mark = await app.inject({ method: 'POST', url: `/api/announcements/${a.id}/read`, headers: { cookie: customerCookie } })
    expect(mark.statusCode).toBe(204)

    const count1 = await app.inject({ method: 'GET', url: '/api/announcements/unread-count', headers: { cookie: customerCookie } })
    expect((count1.json() as { count: number }).count).toBe(1)

    const list = await app.inject({ method: 'GET', url: '/api/announcements', headers: { cookie: customerCookie } })
    const items = list.json() as Array<{ id: string; read: boolean }>
    expect(items.find((i) => i.id === a.id)!.read).toBe(true)
    expect(items.find((i) => i.id === b.id)!.read).toBe(false)

    const mark2 = await app.inject({ method: 'POST', url: `/api/announcements/${a.id}/read`, headers: { cookie: customerCookie } })
    expect(mark2.statusCode).toBe(204)
  })

  it('不同用户已读状态独立', async () => {
    const ann = await createAnn({ audience: 'all', publish: true })
    await app.inject({ method: 'POST', url: `/api/announcements/${ann.id}/read`, headers: { cookie: customerCookie } })

    const memberCount = await app.inject({ method: 'GET', url: '/api/announcements/unread-count', headers: { cookie: memberCookie } })
    expect((memberCount.json() as { count: number }).count).toBe(1)

    const customerCount = await app.inject({ method: 'GET', url: '/api/announcements/unread-count', headers: { cookie: customerCookie } })
    expect((customerCount.json() as { count: number }).count).toBe(0)
  })

  it('草稿/过期/不可见公告不计入 unread count', async () => {
    await createAnn({ audience: 'all' }) // draft
    await createAnn({ audience: 'all', publish: true, expires_at: '2020-01-01T00:00:00Z' }) // expired
    await createAnn({ audience: 'staff', publish: true }) // wrong audience for customer
    await createAnn({ audience: 'all', publish: true }) // only this one

    const count = await app.inject({ method: 'GET', url: '/api/announcements/unread-count', headers: { cookie: customerCookie } })
    expect((count.json() as { count: number }).count).toBe(1)
  })

  it('mark read 不存在的公告 → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/announcements/ghost/read', headers: { cookie: customerCookie } })
    expect(res.statusCode).toBe(404)
  })

  it('mark read 跨 audience 的公告 → 404', async () => {
    const staff = await createAnn({ audience: 'staff', publish: true })
    const res = await app.inject({ method: 'POST', url: `/api/announcements/${staff.id}/read`, headers: { cookie: customerCookie } })
    expect(res.statusCode).toBe(404)
  })
})

// ── 响应安全 ───────────────────────────────────────────────────

describe('响应安全', () => {
  it('下单域响应不含 author_id', async () => {
    await createAnn({ audience: 'all', publish: true })
    const res = await app.inject({ method: 'GET', url: '/api/announcements', headers: { cookie: customerCookie } })
    const items = res.json() as Array<Record<string, unknown>>
    for (const item of items) {
      expect(item).not.toHaveProperty('author_id')
    }
  })
})

// ── 审计 ─────────────────────────────────────────────────────

describe('审计', () => {
  it('create/update/archive 均写 admin_audit', async () => {
    const ann = await createAnn()
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/announcements/${ann.id}`,
      headers: { cookie: adminCookie },
      payload: { title: '改' },
    })
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/announcements/${ann.id}/archive`,
      headers: { cookie: adminCookie },
    })

    const rows = db.prepare('SELECT action FROM admin_audit ORDER BY created_at').all() as Array<{ action: string }>
    const actions = rows.map((r) => r.action)
    expect(actions).toContain('announcement.create')
    expect(actions).toContain('announcement.update')
    expect(actions).toContain('announcement.archive')
  })
})
