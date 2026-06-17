import { randomUUID } from 'node:crypto'
import { checkCalibration, checkConsumableThreshold, raiseAlert } from './alerts.js'
import { type DB } from './db.js'
import { getLog } from './logger.js'
import { lineTotal, moneyC } from './money.js'
import { deriveUnitCost, divRoundHalfUp, overheadC } from './pricing.js'

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

export interface MachineRec {
  mode_id: number
  mode_name: string
  printer_id: number
  printer_code: string
  printer_status: string
  unit_cost_c: number
  queue_pages: number
}

const STATUS_RANK: Record<string, number> = { online: 0, standby: 1, maintenance: 2, offline: 3 }

/**
 * 机器推荐（③⑤）：给定 纸×尺寸（可选单/双面），列出所有「能做」的 mode/printer，
 * 按 在线优先 → 单张参考成本(含 overhead)升序 → 队列负载升序 排序。
 * 「能做」= 尺寸≤max_size ∧ 有纸口径。成本仅作参考，落账仍用实际机器。
 */
export function recommendMachines(
  db: DB,
  paperId: number,
  sizeKey: string,
  duplex?: boolean,
): MachineRec[] {
  const modes = db
    .prepare(
      `SELECT m.id, m.name, m.printer_id, m.duplex,
              p.code AS printer_code, p.status AS printer_status, p.equipment_cost_c,
              m.pricing_mode, m.ink_price_c, m.ml_per_batch, m.yield_sheets,
              rs.area AS ref_area, mx.area AS max_area, s.area AS size_area,
              psc.pack_price_c, psc.pack_count
       FROM print_modes m
       JOIN printers p ON p.id = m.printer_id AND p.archived = 0
       JOIN sizes rs ON rs.key = m.ref_size
       JOIN sizes mx ON mx.key = m.max_size
       JOIN sizes s ON s.key = @size
       LEFT JOIN paper_size_costs psc ON psc.paper_id = @paper AND psc.size_key = @size
       WHERE m.archived = 0 AND s.area <= mx.area AND psc.pack_price_c IS NOT NULL`,
    )
    .all({ paper: paperId, size: sizeKey }) as Array<{
    id: number; name: string; printer_id: number; duplex: number
    printer_code: string; printer_status: string; equipment_cost_c: number
    pricing_mode: string; ink_price_c: number; ml_per_batch: number | null; yield_sheets: number
    ref_area: number; max_area: number; size_area: number
    pack_price_c: number; pack_count: number
  }>

  const queueRows = db
    .prepare(
      `SELECT pm.printer_id, COALESCE(SUM(j.quantity), 0) AS n
       FROM print_modes pm
       JOIN jobs j ON j.mode_id = pm.id AND j.status IN ('queued', 'printing')
       GROUP BY pm.printer_id`,
    )
    .all() as Array<{ printer_id: number; n: number }>
  const queueMap = new Map(queueRows.map((r) => [r.printer_id, r.n]))

  const cfg = db
    .prepare('SELECT overhead_dep_months, overhead_month_volume FROM system_config WHERE id = 1')
    .get() as { overhead_dep_months: number; overhead_month_volume: number }
  const depDen = cfg.overhead_dep_months * cfg.overhead_month_volume

  const recs: MachineRec[] = []
  for (const m of modes) {
    if (duplex !== undefined && m.duplex !== (duplex ? 1 : 0)) continue
    const effInk = m.pricing_mode === 'ml' ? m.ink_price_c * (m.ml_per_batch as number) : m.ink_price_c
    const ink = divRoundHalfUp(effInk * m.size_area, m.yield_sheets * m.ref_area)
    const paper = divRoundHalfUp(m.pack_price_c, m.pack_count)
    const overhead = divRoundHalfUp(m.equipment_cost_c, depDen)
    recs.push({
      mode_id: m.id,
      mode_name: m.name,
      printer_id: m.printer_id,
      printer_code: m.printer_code,
      printer_status: m.printer_status,
      unit_cost_c: ink + paper + overhead,
      queue_pages: queueMap.get(m.printer_id) ?? 0,
    })
  }
  recs.sort(
    (a, b) =>
      (STATUS_RANK[a.printer_status] ?? 4) - (STATUS_RANK[b.printer_status] ?? 4) ||
      a.unit_cost_c - b.unit_cost_c ||
      a.queue_pages - b.queue_pages,
  )
  return recs
}

export interface BoardJob {
  id: string
  title: string
  status: string
  quantity: number
  mode_name: string
  paper_name: string
  size_key: string
  due_date: string | null
}

export interface BoardLane {
  printer_id: number
  code: string
  name: string
  status: string
  jobs: BoardJob[]
  /** 离线/维护机台仍压着活（queued/printing）→ 告警 */
  offline_with_jobs: boolean
}

/**
 * B4 按机台排产板（只读）：每台机器一条泳道，列其 queued/printing 作业（含 due_date，
 * 经订单项/书行两路 join 至 orders.due_date），离线/维护机台仍有活则告警。按 due_date 升序（NULL 殿后）。
 */
export function scheduleBoard(db: DB): BoardLane[] {
  const printers = db
    .prepare("SELECT id, code, name, status FROM printers WHERE archived = 0 ORDER BY id")
    .all() as Array<{ id: number; code: string; name: string; status: string }>

  const rows = db
    .prepare(
      `SELECT j.id, j.title, j.status, j.quantity, j.size_key, m.printer_id,
              m.name AS mode_name, p.name AS paper_name,
              COALESCE(o1.due_date, o2.due_date) AS due_date
       FROM jobs j
       JOIN print_modes m ON m.id = j.mode_id
       JOIN papers p ON p.id = j.paper_id
       LEFT JOIN order_items oi ON oi.id = j.order_item_id
       LEFT JOIN orders o1 ON o1.id = oi.order_id
       LEFT JOIN order_book_components obc ON obc.job_id = j.id
       LEFT JOIN order_books ob ON ob.id = obc.order_book_id
       LEFT JOIN orders o2 ON o2.id = ob.order_id
       WHERE j.status IN ('queued', 'printing')
       ORDER BY (COALESCE(o1.due_date, o2.due_date) IS NULL),
                COALESCE(o1.due_date, o2.due_date), j.created_at`,
    )
    .all() as Array<BoardJob & { printer_id: number }>

  const byPrinter = new Map<number, BoardJob[]>()
  for (const r of rows) {
    const { printer_id, ...job } = r
    const lane = byPrinter.get(printer_id)
    if (lane) lane.push(job)
    else byPrinter.set(printer_id, [job])
  }

  return printers.map((p) => {
    const jobs = byPrinter.get(p.id) ?? []
    return {
      printer_id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      jobs,
      offline_with_jobs: (p.status === 'offline' || p.status === 'maintenance') && jobs.length > 0,
    }
  })
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

  // §3.1 扣减须与 availability() 同口径（按 paper×size 汇总）：跨多库位确定性抽取，
  // 大库位优先、最后一行吸收不足（账面可为负，不阻断）。物理抽取额按「先 consume(quantity) 后 scrap(waste)」切分到各行。
  const stockRows = db
    .prepare(
      `SELECT id, quantity FROM paper_stocks
       WHERE paper_id = ? AND size_key = ? AND archived = 0
       ORDER BY quantity DESC, id`,
    )
    .all(job.paper_id, job.size_key) as Array<{ id: string; quantity: number }>
  if (stockRows.length === 0) throw new JobError(409, 'no_stock_record')

  const draws: Array<{ id: string; before: number; consume: number; scrap: number }> = []
  let remaining = consumed
  let consumeLeft = job.quantity
  for (let i = 0; i < stockRows.length && remaining > 0; i++) {
    const row = stockRows[i] as { id: string; quantity: number }
    const isLast = i === stockRows.length - 1
    const take = isLast ? remaining : Math.min(row.quantity, remaining)
    if (take <= 0) continue
    const consumePart = Math.min(take, consumeLeft)
    consumeLeft -= consumePart
    draws.push({ id: row.id, before: row.quantity, consume: consumePart, scrap: take - consumePart })
    remaining -= take
  }

  const now = new Date().toISOString()
  const insertLog = db.prepare(
    `INSERT INTO inventory_log (id, target_type, target_id, action, quantity_delta,
                                reason, operator_id, related_job_id, created_at)
     VALUES (?, 'paper_stock', ?, ?, ?, ?, ?, ?, ?)`,
  )

  const log = getLog()
  log.info({ jobId, quantity: job.quantity, waste, pages, consumed, totalCost, profit }, 'job.complete begin')
  const updateStock = db.prepare('UPDATE paper_stocks SET quantity = quantity - ? WHERE id = ?')
  const selectConsumables = db.prepare(
    `SELECT id FROM consumables WHERE printer_id = ? AND cost_model = 'per_page' AND archived = 0`,
  )
  const updateConsumable = db.prepare('UPDATE consumables SET current_usage_pages = current_usage_pages + ? WHERE id = ?')
  const updatePrinter = db.prepare('UPDATE printers SET total_pages = total_pages + ? WHERE id = ?')
  const updateJob = db.prepare(
    `UPDATE jobs SET status = 'done', waste_quantity = ?, pages_consumed = ?,
       paper_cost_c = ?, consumable_cost_c = ?, overhead_cost_c = ?,
       total_cost = ?, profit = ?, completed_at = ?, operator_id = ?
     WHERE id = ?`,
  )
  try {
    db.transaction(() => {
      for (const d of draws) {
        const drawn = d.consume + d.scrap
        updateStock.run(drawn, d.id)
        if (d.consume > 0) {
          insertLog.run(randomUUID(), d.id, 'consume', -d.consume, null, input.operatorId ?? null, jobId, now)
        }
        if (d.scrap > 0) {
          insertLog.run(randomUUID(), d.id, 'scrap', -d.scrap, '废品', input.operatorId ?? null, jobId, now)
        }
        if (d.before - drawn < 0) {
          log.warn({ jobId, stockId: d.id, after: d.before - drawn }, 'stock negative after draw')
          raiseAlert(db, {
            type: 'low_stock',
            severity: 'critical',
            target_type: 'paper_stock',
            target_id: d.id,
            message: `作业 ${jobId} 落账后库位 ${d.id} 账面为负（${d.before - drawn}），需盘点调整`,
          })
        }
      }

      const consumables = selectConsumables.all(job.printer_id) as Array<{ id: string }>
      for (const c of consumables) {
        updateConsumable.run(pages, c.id)
        checkConsumableThreshold(db, c.id)
      }

      updatePrinter.run(pages, job.printer_id)
      checkCalibration(db, job.printer_id)

      updateJob.run(
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
    log.info({ jobId }, 'job.complete committed')
  } catch (err) {
    log.error({ jobId, err }, 'job.complete rolled back')
    throw err
  }
}
