import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, openDb, type DB } from './db.js'
import { getPayments, PaymentError, projectStatus, recordPayment } from './payments.js'
import { makeTestDb, withSystemConfig } from './test-helpers.js'

describe('D28 projectStatus 投影', () => {
  it('0→unpaid · 0<paid<total→deposit · paid≥total→paid', () => {
    expect(projectStatus(0, 1000)).toBe('unpaid')
    expect(projectStatus(-5, 1000)).toBe('unpaid')
    expect(projectStatus(1, 1000)).toBe('deposit')
    expect(projectStatus(999, 1000)).toBe('deposit')
    expect(projectStatus(1000, 1000)).toBe('paid')
    expect(projectStatus(1500, 1000)).toBe('paid')
  })
})

describe('0011 迁移回填：既有 paid_amount → 一条投影流水', () => {
  it('paid<total → deposit；paid≥total → balance；paid=0 → 无流水', () => {
    const db = openDb(':memory:')
    // 仅应用至 0010，制造「迁移前」既有订单
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{4}_.+\.sql$/.test(x)).sort()) {
      if (Number(f.slice(0, 4)) > 10) break
      db.exec(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    }
    db.exec("INSERT INTO system_config (id, base_currency, initialized_at) VALUES (1,'JPY','2026-01-01T00:00:00Z')")
    db.prepare("INSERT INTO users (id,email,password_hash,name,role,created_at) VALUES ('u1','a@b.c','h','A','customer','2026-01-01T00:00:00Z')").run()
    const ins = db.prepare(
      `INSERT INTO orders (id, order_number, access_token, customer_id, subtotal, discount, total,
                           payment_status, paid_amount, payment_method, paid_at, quote_valid_until, created_at)
       VALUES (?, ?, ?, 'u1', ?, 0, ?, ?, ?, ?, ?, '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    ins.run('o-dep', 'FOL-1', 't1', 1000, 1000, 'deposit', 400, '现金', '2026-01-02T00:00:00Z')
    ins.run('o-paid', 'FOL-2', 't2', 1000, 1000, 'paid', 1000, 'PayPay', '2026-01-03T00:00:00Z')
    ins.run('o-zero', 'FOL-3', 't3', 1000, 1000, 'unpaid', 0, null, null)

    db.exec(readFileSync(path.join(MIGRATIONS_DIR, '0011_payments.sql'), 'utf8'))

    const dep = getPayments(db, 'o-dep')
    expect(dep).toHaveLength(1)
    expect(dep[0]!.kind).toBe('deposit')
    expect(dep[0]!.amount).toBe(400)
    expect(dep[0]!.method).toBe('现金')

    const paid = getPayments(db, 'o-paid')
    expect(paid).toHaveLength(1)
    expect(paid[0]!.kind).toBe('balance') // paid_amount >= total
    expect(paid[0]!.amount).toBe(1000)

    expect(getPayments(db, 'o-zero')).toHaveLength(0)
    db.close()
  })
})

describe('recordPayment 直接契约', () => {
  let db: DB
  beforeEach(() => {
    db = makeTestDb()
    withSystemConfig(db)
    db.prepare("INSERT INTO users (id,email,password_hash,name,role,created_at) VALUES ('u1','a@b.c','h','A','customer','2026-01-01T00:00:00Z')").run()
    db.prepare(
      `INSERT INTO orders (id, order_number, access_token, customer_id, subtotal, discount, total,
                           payment_status, paid_amount, quote_valid_until, created_at)
       VALUES ('o1','FOL-1','t1','u1',1000,0,1000,'unpaid',0,'2026-02-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    ).run()
  })
  afterEach(() => db.close())

  it('追加流水后重算 orders 投影（paid_amount/payment_status）', () => {
    recordPayment(db, 'o1', { kind: 'deposit', amount: 300 })
    let o = db.prepare("SELECT paid_amount, payment_status FROM orders WHERE id='o1'").get() as { paid_amount: number; payment_status: string }
    expect(o.paid_amount).toBe(300)
    expect(o.payment_status).toBe('deposit')
    recordPayment(db, 'o1', { kind: 'balance', amount: 700 })
    o = db.prepare("SELECT paid_amount, payment_status FROM orders WHERE id='o1'").get() as { paid_amount: number; payment_status: string }
    expect(o.paid_amount).toBe(1000)
    expect(o.payment_status).toBe('paid')
  })

  it('超付 / 退过 / kind↔符号 → PaymentError 422', () => {
    expect(() => recordPayment(db, 'o1', { kind: 'balance', amount: 1001 })).toThrow(PaymentError)
    expect(() => recordPayment(db, 'o1', { kind: 'refund', amount: -1 })).toThrow(/refund_exceeds_paid/)
    expect(() => recordPayment(db, 'o1', { kind: 'deposit', amount: -5 })).toThrow(/charge_must_be_positive/)
    expect(() => recordPayment(db, 'o1', { kind: 'refund', amount: 5 })).toThrow(/refund_must_be_negative/)
    // 这些 422 都不应落账
    expect(getPayments(db, 'o1')).toHaveLength(0)
  })

  it('未知订单 → 404', () => {
    expect(() => recordPayment(db, 'nope', { kind: 'deposit', amount: 1 })).toThrow(/not_found/)
  })
})
