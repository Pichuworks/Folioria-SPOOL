import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, SESSION_COOKIE, type App } from './app.js'
import { type DB } from './db.js'
import { spoolInit } from './init.js'
import { syncFileState } from './orders.js'
import { importSeed } from './seed.js'
import { collectForbiddenKeys, createTestUser, makeTestDb } from './test-helpers.js'

/**
 * acceptance §5（订单）+ §6（双域权限）。
 * 基准真值（§1.2/§2.3，seed 数据）：
 *   mode 1 黑白·单 × paper 1 打印纸70g @ A4 → 手动价 7_c；7×200/100 = 14 円
 *   mode 6 彩图·单 × paper 6 铜版128g @ A3 → 手动价 90_c；90×100/100 = 90 円
 */

const A4_ITEM = { mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 200 }
const A3_ITEM = { mode_id: 6, paper_id: 6, size_key: 'A3', quantity: 100 }

let db: DB
let app: App

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
  createTestUser(db, { email: 'm@member.example', role: 'member' })
  createTestUser(db, { email: 'staff@folioria.jp', role: 'admin' })
  createTestUser(db, { email: 'raw@cust.example', emailVerified: false })
  app = buildApp(db)
})
afterEach(async () => {
  await app.close()
  db.close()
})

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password' },
  })
  expect(res.statusCode).toBe(200)
  const raw = String(res.headers['set-cookie'])
  const match = /spool_session=([^;]+)/.exec(raw)
  return `${SESSION_COOKIE}=${match?.[1]}`
}

interface OrderDto {
  id: string
  order_number: string
  access_token: string
  status: string
  subtotal: number
  discount: number
  total: number
  total_display: string
  payment_status: string
  paid_amount: number
  quote_valid_until: string
  quote_expired: boolean
  is_internal?: boolean
  items: Array<{
    id: string
    unit_price_c: number
    unit_display: string
    line_total: number
    quantity: number
    file_status: string
    file_note: string | null
    has_file: boolean
    job_id?: string | null
  }>
}

async function placeOrder(
  cookie: string,
  items: Array<{ mode_id: number; paper_id: number; size_key: string; quantity: number }> = [A4_ITEM, A3_ITEM],
): Promise<OrderDto> {
  const res = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload: { items } })
  expect(res.statusCode).toBe(201)
  return res.json() as OrderDto
}

/** 块③上传端点前的文件占位：直接落 file_url 后跑系统自动流转 */
function stuffFiles(orderId: string): void {
  db.prepare('UPDATE order_items SET file_url = ? WHERE order_id = ?').run(`${randomUUID()}.pdf`, orderId)
  syncFileState(db, orderId)
}

async function reviewAll(adminCookie: string, order: OrderDto, verdict: 'approved' | 'rejected'): Promise<OrderDto> {
  let last: OrderDto | undefined
  const fresh = await app.inject({ method: 'GET', url: `/api/orders/${order.id}`, headers: { cookie: adminCookie } })
  for (const item of (fresh.json() as OrderDto).items) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${item.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: verdict },
    })
    expect(res.statusCode).toBe(200)
    last = res.json() as OrderDto
  }
  return last as OrderDto
}

describe('R3 下单与金额（§1.2/§1.3 唯一舍入点 + 快照）', () => {
  it('下单成功：unit_price_c 取报价、line_total 唯一舍入点、subtotal 整数加法、状态 quoted', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie)
    expect(order.status).toBe('quoted')
    expect(order.order_number).toMatch(/^FOL-\d{4}-0001$/)
    expect(order.access_token.length).toBeGreaterThanOrEqual(24)
    expect(order.items[0]?.unit_price_c).toBe(7)
    expect(order.items[0]?.line_total).toBe(14)
    expect(order.items[1]?.unit_price_c).toBe(90)
    expect(order.items[1]?.line_total).toBe(90)
    expect(order.subtotal).toBe(104)
    expect(order.total).toBe(104)
    expect(order.total_display).toBe('¥104')
    // 第二单序号递增
    const second = await placeOrder(cookie, [A4_ITEM])
    expect(second.order_number).toMatch(/-0002$/)
  })

  it('unit_price_c 下单定格：改定价表不影响既有订单（§5）', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, [A4_ITEM])
    db.prepare(
      `UPDATE combo_prices SET sell_c = 999
       WHERE size_key = 'A4' AND combo_id = (SELECT id FROM combos WHERE mode_id = 1 AND paper_id = 1)`,
    ).run()
    const after = await app.inject({ method: 'GET', url: `/api/orders/${order.id}`, headers: { cookie } })
    const dto = after.json() as OrderDto
    expect(dto.items[0]?.unit_price_c).toBe(7)
    expect(dto.items[0]?.line_total).toBe(14)
    expect(dto.subtotal).toBe(14)
  })

  it('member 下单取 internal_sell_c 口径并置 is_internal=1（B1.1）', async () => {
    db.prepare(
      `UPDATE combo_prices SET internal_sell_c = 5
       WHERE size_key = 'A4' AND combo_id = (SELECT id FROM combos WHERE mode_id = 1 AND paper_id = 1)`,
    ).run()
    const cookie = await login('m@member.example')
    const order = await placeOrder(cookie, [A4_ITEM])
    expect(order.items[0]?.unit_price_c).toBe(5)
    expect(order.items[0]?.line_total).toBe(10)
    const row = db.prepare('SELECT is_internal FROM orders WHERE id = ?').get(order.id) as { is_internal: number }
    expect(row.is_internal).toBe(1)
  })

  it('不可报价组合（§2.4 尺寸越界）→ 422；quantity 非整数 → 422', async () => {
    const cookie = await login('a@cust.example')
    const oversize = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { items: [{ mode_id: 9, paper_id: 1, size_key: 'A3', quantity: 10 }] },
    })
    expect(oversize.statusCode).toBe(422)
    const fraction = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { items: [{ ...A4_ITEM, quantity: 1.5 }] },
    })
    expect(fraction.statusCode).toBe(422)
  })

  it('R4: 未验证邮箱可登录但下单 403 email_unverified；guest 401', async () => {
    const cookie = await login('raw@cust.example')
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { items: [A4_ITEM] },
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: string }).error).toBe('email_unverified')

    expect(
      (await app.inject({ method: 'POST', url: '/api/orders', payload: { items: [A4_ITEM] } })).statusCode,
    ).toBe(401)
  })
})

describe('R2 access_token 防枚举（§5/§6）', () => {
  it('by-token 查询：正确 token 200；错误 token 404；order_number 不可作查询键 → 404', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie)

    const ok = await app.inject({ method: 'GET', url: `/api/orders/by-token/${order.access_token}` })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as OrderDto).id).toBe(order.id)
    expect(collectForbiddenKeys(ok.json())).toEqual([])

    expect((await app.inject({ method: 'GET', url: '/api/orders/by-token/wrong-token' })).statusCode).toBe(404)
    expect(
      (await app.inject({ method: 'GET', url: `/api/orders/by-token/${order.order_number}` })).statusCode,
    ).toBe(404)
  })

  it('customer A 用 B 的订单 id/token → 404（不泄露存在性）', async () => {
    const cookieB = await login('b@cust.example')
    const orderB = await placeOrder(cookieB, [A4_ITEM])

    const cookieA = await login('a@cust.example')
    expect(
      (await app.inject({ method: 'GET', url: `/api/orders/${orderB.id}`, headers: { cookie: cookieA } }))
        .statusCode,
    ).toBe(404)
    // A 列表里看不到 B 的单
    const list = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: cookieA } })
    expect((list.json() as OrderDto[]).length).toBe(0)
    // 状态操作同理 404
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/orders/${orderB.id}/status`,
          headers: { cookie: cookieA },
          payload: { status: 'cancelled' },
        })
      ).statusCode,
    ).toBe(404)
  })
})

describe('R1 状态机（§2.5 + 审稿定点）', () => {
  it('全部 item 有文件 → 自动 file_pending；全 approved → file_approved；任一 rejected → 回 file_pending', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie)

    stuffFiles(order.id)
    expect((db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id) as { status: string }).status).toBe(
      'file_pending',
    )

    // 一过一驳 → 仍 file_pending，驳回意见落 item
    const fresh = await app.inject({ method: 'GET', url: `/api/orders/${order.id}`, headers: { cookie: adminCookie } })
    const items = (fresh.json() as OrderDto).items
    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${items[0]?.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: 'approved' },
    })
    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${items[1]?.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: 'rejected', file_note: '出血不足 3mm' },
    })
    const afterReject = rejected.json() as OrderDto
    expect(afterReject.status).toBe('file_pending')
    expect(afterReject.items[1]?.file_status).toBe('rejected')
    expect(afterReject.items[1]?.file_note).toBe('出血不足 3mm')

    // 重审通过 → file_approved
    const approved = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${items[1]?.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: 'approved' },
    })
    expect((approved.json() as OrderDto).status).toBe('file_approved')
  })

  it('无文件审稿 → 409；手动指定 file_pending/file_approved → 422（系统自动流转专属）', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, [A4_ITEM])
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file-review`,
      headers: { cookie: adminCookie },
      payload: { file_status: 'approved' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe('no_file_to_review')

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/orders/${order.id}/status`,
          headers: { cookie: adminCookie },
          payload: { status: 'file_pending' },
        })
      ).statusCode,
    ).toBe(422)
  })

  it('confirm 仅 file_approved 可达：quoted/file_pending → 409；confirmed 后建 Job(queued) 回写 job_id', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie)

    // quoted → confirm 409
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/orders/${order.id}/status`,
          headers: { cookie: adminCookie },
          payload: { status: 'confirmed' },
        })
      ).statusCode,
    ).toBe(409)

    stuffFiles(order.id)
    await reviewAll(adminCookie, order, 'approved')

    const confirmed = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'confirmed' },
    })
    expect(confirmed.statusCode).toBe(200)
    const dto = confirmed.json() as OrderDto
    expect(dto.status).toBe('confirmed')

    // 逐 item 生成 Job(queued, quoted_price=line_total, order_item_id 关联) 并回写 job_id
    for (const item of dto.items) {
      expect(item.job_id).toBeTruthy()
      const job = db
        .prepare('SELECT status, quoted_price, order_item_id, quantity, requester_id FROM jobs WHERE id = ?')
        .get(item.job_id) as {
        status: string
        quoted_price: number
        order_item_id: string
        quantity: number
        requester_id: string
      }
      expect(job.status).toBe('queued')
      expect(job.quoted_price).toBe(item.line_total)
      expect(job.order_item_id).toBe(item.id)
      expect(job.quantity).toBe(item.quantity)
    }
  })

  it('§5: 过期 quoted 订单 confirm 拒绝 409；其余状态不受影响', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, [A4_ITEM])
    stuffFiles(order.id)
    await reviewAll(adminCookie, order, 'approved')
    db.prepare("UPDATE orders SET quote_valid_until = '2020-01-01T00:00:00Z' WHERE id = ?").run(order.id)

    const expired = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'confirmed' },
    })
    expect(expired.statusCode).toBe(409)
    expect((expired.json() as { error: string }).error).toBe('quote_expired')

    // 已确认的单不受时效影响：恢复时效 confirm，再过期，照常推进生产
    db.prepare("UPDATE orders SET quote_valid_until = '2099-01-01T00:00:00Z' WHERE id = ?").run(order.id)
    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'confirmed' },
    })
    db.prepare("UPDATE orders SET quote_valid_until = '2020-01-01T00:00:00Z' WHERE id = ?").run(order.id)
    const production = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'in_production' },
    })
    expect(production.statusCode).toBe(200)
    expect((production.json() as OrderDto).status).toBe('in_production')
  })

  it('推进链 confirmed→in_production→ready→delivered（completed_at 落档）；跳级 → 409', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, [A4_ITEM])
    stuffFiles(order.id)
    await reviewAll(adminCookie, order, 'approved')

    const advance = async (status: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/orders/${order.id}/status`,
        headers: { cookie: adminCookie },
        payload: { status },
      })

    // 跳级：file_approved → ready 拒绝
    expect((await advance('ready')).statusCode).toBe(409)

    await advance('confirmed')
    await advance('in_production')
    await advance('ready')
    const delivered = await advance('delivered')
    expect(delivered.statusCode).toBe(200)
    const row = db.prepare('SELECT status, completed_at FROM orders WHERE id = ?').get(order.id) as {
      status: string
      completed_at: string | null
    }
    expect(row.status).toBe('delivered')
    expect(row.completed_at).not.toBeNull()
    // 终态不可再动
    expect((await advance('cancelled')).statusCode).toBe(409)
  })

  it('取消权限：customer 仅 confirm 前自己的单；confirmed 起仅 admin，连带取消未完成 Job', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')

    // customer 取消自己 quoted 的单
    const o1 = await placeOrder(cookie, [A4_ITEM])
    const cancel1 = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${o1.id}/status`,
      headers: { cookie },
      payload: { status: 'cancelled' },
    })
    expect(cancel1.statusCode).toBe(200)
    expect((cancel1.json() as OrderDto).status).toBe('cancelled')

    // customer 不可推进其他状态
    const o2 = await placeOrder(cookie, [A4_ITEM])
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/orders/${o2.id}/status`,
          headers: { cookie },
          payload: { status: 'ready' },
        })
      ).statusCode,
    ).toBe(403)

    // confirmed 后 customer 取消 → 409；admin 取消 → 200 且 Job 连带 cancelled
    stuffFiles(o2.id)
    await reviewAll(adminCookie, o2, 'approved')
    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${o2.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'confirmed' },
    })
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/orders/${o2.id}/status`,
          headers: { cookie },
          payload: { status: 'cancelled' },
        })
      ).statusCode,
    ).toBe(409)

    const adminCancel = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${o2.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'cancelled' },
    })
    expect(adminCancel.statusCode).toBe(200)
    const jobs = db
      .prepare(
        `SELECT status FROM jobs WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
      )
      .all(o2.id) as Array<{ status: string }>
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.every((j) => j.status === 'cancelled')).toBe(true)
  })
})

describe('R6 收款与折扣（§5/C7）', () => {
  it('discount: 非整数/负数 → 422；超 subtotal → 422；合法值 total=subtotal−discount 整数减法', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie) // subtotal 104

    const cases = [
      { payload: { discount: 1.5 }, code: 422 },
      { payload: { discount: -10 }, code: 422 },
      { payload: { discount: '10' }, code: 422 },
      { payload: { discount: 105 }, code: 422 },
    ]
    for (const c of cases) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/orders/${order.id}/discount`,
        headers: { cookie: adminCookie },
        payload: c.payload,
      })
      expect(res.statusCode).toBe(c.code)
    }

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/discount`,
      headers: { cookie: adminCookie },
      payload: { discount: 4 },
    })
    expect(ok.statusCode).toBe(200)
    const dto = ok.json() as OrderDto
    expect(dto.discount).toBe(4)
    expect(dto.total).toBe(100)
    expect(dto.total_display).toBe('¥100')
  })

  it('payment: deposit/paid 落 paid_amount/method/paid_at；unpaid 清零', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, [A4_ITEM])

    const deposit = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/payment`,
      headers: { cookie: adminCookie },
      payload: { payment_status: 'deposit', paid_amount: 7, payment_method: '现金' },
    })
    expect(deposit.statusCode).toBe(200)
    const d = deposit.json() as OrderDto & { payment_method: string; paid_at: string }
    expect(d.payment_status).toBe('deposit')
    expect(d.paid_amount).toBe(7)
    expect(d.payment_method).toBe('现金')
    expect(d.paid_at).toBeTruthy()

    const paid = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/payment`,
      headers: { cookie: adminCookie },
      payload: { payment_status: 'paid', paid_amount: 14 },
    })
    expect((paid.json() as OrderDto).paid_amount).toBe(14)

    const unpaid = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/payment`,
      headers: { cookie: adminCookie },
      payload: { payment_status: 'unpaid' },
    })
    const u = unpaid.json() as OrderDto & { paid_at: string | null }
    expect(u.paid_amount).toBe(0)
    expect(u.paid_at).toBeNull()
  })

  it('金额字段传 1.5 / "100" → 422（§7 边界，paid_amount）', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, [A4_ITEM])
    for (const bad of [1.5, '100']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/orders/${order.id}/payment`,
        headers: { cookie: adminCookie },
        payload: { payment_status: 'paid', paid_amount: bad },
      })
      expect(res.statusCode).toBe(422)
    }
  })
})

describe('§6 双域权限与序列化白名单', () => {
  it('下单域全部订单端点响应深度遍历：无 cost/profit/margin 键', async () => {
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie)

    const created = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload: { items: [A4_ITEM] } })
    expect(collectForbiddenKeys(created.json())).toEqual([])

    const list = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie } })
    expect(collectForbiddenKeys(list.json())).toEqual([])

    const single = await app.inject({ method: 'GET', url: `/api/orders/${order.id}`, headers: { cookie } })
    expect(collectForbiddenKeys(single.json())).toEqual([])

    const byToken = await app.inject({ method: 'GET', url: `/api/orders/by-token/${order.access_token}` })
    expect(collectForbiddenKeys(byToken.json())).toEqual([])

    const cancelled = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie },
      payload: { status: 'cancelled' },
    })
    expect(collectForbiddenKeys(cancelled.json())).toEqual([])
  })

  it('confirm 建 Job 后，下单域订单响应仍不泄漏成本侧字段', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    const order = await placeOrder(cookie, [A4_ITEM])
    stuffFiles(order.id)
    await reviewAll(adminCookie, order, 'approved')
    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'confirmed' },
    })
    const single = await app.inject({ method: 'GET', url: `/api/orders/${order.id}`, headers: { cookie } })
    expect(collectForbiddenKeys(single.json())).toEqual([])
    // customer 视图不含 job_id / is_internal / customer
    const dto = single.json() as Record<string, unknown> & { items: Array<Record<string, unknown>> }
    expect('is_internal' in dto).toBe(false)
    expect('customer' in dto).toBe(false)
    expect(dto.items.every((i) => !('job_id' in i))).toBe(true)
  })

  it('member/customer 调管理域订单操作 → 403', async () => {
    const cookie = await login('a@cust.example')
    const memberCookie = await login('m@member.example')
    const order = await placeOrder(cookie, [A4_ITEM])
    stuffFiles(order.id)

    for (const c of [cookie, memberCookie]) {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file-review`,
            headers: { cookie: c },
            payload: { file_status: 'approved' },
          })
        ).statusCode,
      ).toBe(403)
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/orders/${order.id}/payment`,
            headers: { cookie: c },
            payload: { payment_status: 'paid' },
          })
        ).statusCode,
      ).toBe(403)
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/orders/${order.id}/discount`,
            headers: { cookie: c },
            payload: { discount: 1 },
          })
        ).statusCode,
      ).toBe(403)
    }
  })

  it('admin 列表可见全部订单与客户信息；customer 列表仅自己的', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookieA = await login('a@cust.example')
    const cookieB = await login('b@cust.example')
    await placeOrder(cookieA, [A4_ITEM])
    await placeOrder(cookieB, [A3_ITEM])

    const adminList = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: adminCookie } })
    const all = adminList.json() as Array<OrderDto & { customer?: { email: string } }>
    expect(all.length).toBe(2)
    expect(all.every((o) => o.customer?.email)).toBe(true)

    const aList = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: cookieA } })
    expect((aList.json() as OrderDto[]).length).toBe(1)
  })
})

describe('§3.1 订单作业 done 落账回归（done 只走既有 completeJob）', () => {
  it('confirm 生成的 Job 完成后：库存扣减、quoted_price 进毛利核算', async () => {
    const adminCookie = await login('staff@folioria.jp')
    const cookie = await login('a@cust.example')
    db.prepare(
      "INSERT INTO paper_stocks (id, paper_id, size_key, quantity) VALUES ('ps-test', 1, 'A4', 500)",
    ).run()

    const order = await placeOrder(cookie, [A4_ITEM]) // 200 张
    stuffFiles(order.id)
    await reviewAll(adminCookie, order, 'approved')
    const confirmed = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'confirmed' },
    })
    const jobId = (confirmed.json() as OrderDto).items[0]?.job_id as string

    const done = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/done`,
      headers: { cookie: adminCookie },
      payload: { waste_quantity: 3 },
    })
    expect(done.statusCode).toBe(200)
    const job = done.json() as { status: string; total_cost: number; profit: number; quoted_price: number }
    expect(job.status).toBe('done')
    expect(job.quoted_price).toBe(14)
    expect(job.profit).toBe(job.quoted_price - job.total_cost)

    const stock = db.prepare("SELECT quantity FROM paper_stocks WHERE id = 'ps-test'").get() as {
      quantity: number
    }
    expect(stock.quantity).toBe(500 - 203)
  })
})
