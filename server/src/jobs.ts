import { randomUUID } from 'node:crypto'
import { checkCalibration, checkConsumableThreshold, raiseAlert } from './alerts.js'
import { type DB } from './db.js'
import { lineTotal, moneyC } from './money.js'
import { deriveUnitCost, overheadC } from './pricing.js'

export class JobError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['printing', 'cancelled'],
  printing: ['cancelled'],
  done: [],
  cancelled: [],
}

/** done 只能经 completeJob（落账事务）；其余流转走这里 */
export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

interface JobRow {
  id: string
  status: string
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  quoted_price: number | null
  duplex: number
  printer_id: number
}

export interface AvailabilityInfo {
  paper_id: number
  size_key: string
  on_hand: number
  reserved: number
  available: number
}

/** §3.3 可用量动态计算：不落库，纯查询 */
export function availability(db: DB, paperId: number, sizeKey: string): AvailabilityInfo {
  const onHand = (
    db
      .prepare(
        'SELECT COALESCE(SUM(quantity), 0) n FROM paper_stocks WHERE paper_id = ? AND size_key = ? AND archived = 0',
      )
      .get(paperId, sizeKey) as { n: number }
  ).n
  const reserved = (
    db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) n FROM jobs
         WHERE paper_id = ? AND size_key = ? AND status IN ('queued', 'printing')`,
      )
      .get(paperId, sizeKey) as { n: number }
  ).n
  return {
    paper_id: paperId,
    size_key: sizeKey,
    on_hand: onHand,
    reserved,
    available: onHand - reserved,
  }
}

export interface CompleteJobInput {
  wasteQuantity: number
  pagesConsumed?: number | undefined
  operatorId?: string | undefined
}

/**
 * C3/§3.1 done 一次性落账，全程单事务：
 *   paper_stock −(quantity+waste) → inventory_log(consume[+scrap])
 *   该打印机全部在役 per_page 耗材 usage += 实耗面数 → 阈值检查
 *   printer.total_pages += 实耗面数 → 校准检查
 *   成本快照按 §2.3 推导定格（单价层）+ total_cost/profit（金额层）
 */
export function completeJob(db: DB, jobId: string, input: CompleteJobInput): void {
  const job = db
    .prepare(
      `SELECT j.id, j.status, j.mode_id, j.paper_id, j.size_key, j.quantity, j.quoted_price,
              m.duplex, m.printer_id
       FROM jobs j JOIN print_modes m ON m.id = j.mode_id
       WHERE j.id = ?`,
    )
    .get(jobId) as JobRow | undefined
  if (!job) throw new JobError(404, 'job_not_found')
  if (job.status !== 'queued' && job.status !== 'printing') {
    throw new JobError(409, `job_not_completable_from_${job.status}`)
  }

  const waste = input.wasteQuantity
  const consumed = job.quantity + waste
  const pages = input.pagesConsumed ?? consumed * (job.duplex !== 0 ? 2 : 1)

  const cost = deriveUnitCost(db, job.mode_id, job.paper_id, job.size_key)
  if (!cost) throw new JobError(409, 'unit_cost_underivable')
  const overhead = overheadC(db, job.printer_id)
  const unitTotal = moneyC(cost.ink_c + cost.paper_c + overhead)
  const totalCost = lineTotal(unitTotal, consumed)
  const profit = job.quoted_price == null ? null : job.quoted_price - totalCost

  const stock = db
    .prepare(
      `SELECT id, quantity FROM paper_stocks
       WHERE paper_id = ? AND size_key = ? AND archived = 0
       ORDER BY quantity DESC LIMIT 1`,
    )
    .get(job.paper_id, job.size_key) as { id: string; quantity: number } | undefined
  if (!stock) throw new JobError(409, 'no_stock_record')

  const now = new Date().toISOString()
  const insertLog = db.prepare(
    `INSERT INTO inventory_log (id, target_type, target_id, action, quantity_delta,
                                reason, operator_id, related_job_id, created_at)
     VALUES (?, 'paper_stock', ?, ?, ?, ?, ?, ?, ?)`,
  )

  db.transaction(() => {
    db.prepare('UPDATE paper_stocks SET quantity = quantity - ? WHERE id = ?').run(consumed, stock.id)
    insertLog.run(randomUUID(), stock.id, 'consume', -job.quantity, null, input.operatorId ?? null, jobId, now)
    if (waste > 0) {
      insertLog.run(randomUUID(), stock.id, 'scrap', -waste, '废品', input.operatorId ?? null, jobId, now)
    }
    // 实物打穿账面：不阻断（已发生的消耗必须入账），但立即拉响警报
    if (stock.quantity - consumed < 0) {
      raiseAlert(db, {
        type: 'low_stock',
        severity: 'critical',
        target_type: 'paper_stock',
        target_id: stock.id,
        message: `作业 ${jobId} 落账后账面为负（${stock.quantity - consumed}），需盘点调整`,
      })
    }

    const consumables = db
      .prepare(
        `SELECT id FROM consumables
         WHERE printer_id = ? AND cost_model = 'per_page' AND archived = 0`,
      )
      .all(job.printer_id) as Array<{ id: string }>
    for (const c of consumables) {
      db.prepare('UPDATE consumables SET current_usage_pages = current_usage_pages + ? WHERE id = ?').run(pages, c.id)
      checkConsumableThreshold(db, c.id)
    }

    db.prepare('UPDATE printers SET total_pages = total_pages + ? WHERE id = ?').run(pages, job.printer_id)
    checkCalibration(db, job.printer_id)

    db.prepare(
      `UPDATE jobs SET status = 'done', waste_quantity = ?, pages_consumed = ?,
         paper_cost_c = ?, consumable_cost_c = ?, overhead_cost_c = ?,
         total_cost = ?, profit = ?, completed_at = ?, operator_id = ?
       WHERE id = ?`,
    ).run(
      waste,
      pages,
      cost.paper_c,
      cost.ink_c,
      overhead,
      totalCost,
      profit,
      now,
      input.operatorId ?? null,
      jobId,
    )
  })()
}
