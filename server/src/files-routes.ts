import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { type MultipartFile } from '@fastify/multipart'
import { type FastifyInstance, type FastifyReply } from 'fastify'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { requireUser } from './guards.js'
import { notifyAdmins, templates } from './notify.js'
import { getOrder, OrderError, syncFileState, type OrderRow } from './orders.js'
import { ERROR_SCHEMA, ORDER_SCHEMA, orderDto } from './orders-routes.js'
import { precheckFile, type PrecheckResult, type PrecheckTarget } from './precheck.js'

/** R5: 类型白名单——扩展名与 magic bytes 双查，二者一致才收（PDF/TIFF/PNG，PRD §2.5） */
const EXT_TO_KIND: Record<string, 'pdf' | 'png' | 'tiff'> = {
  pdf: 'pdf',
  png: 'png',
  tif: 'tiff',
  tiff: 'tiff',
}

export function sniffMagic(head: Buffer): 'pdf' | 'png' | 'tiff' | null {
  if (head.length >= 4 && head.toString('latin1', 0, 4) === '%PDF') return 'pdf'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png'
  }
  if (head.length >= 4) {
    const b = head.subarray(0, 4)
    if (b.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || b.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) {
      return 'tiff'
    }
  }
  return null
}

export const defaultUploadDir = (): string =>
  process.env['SPOOL_UPLOAD_DIR'] ?? path.join(os.homedir(), '.local', 'share', 'spool', 'uploads')

/** 上传仅在审稿闭环内：quoted（首传）与 file_pending（驳回重传）。file_approved 起冻结 */
const UPLOADABLE: readonly string[] = ['quoted', 'file_pending']

/**
 * R5 落盘核心（order_item 与书组件共用）：白名单扩展 + magic bytes 双查，randomUUID 存储名
 * （不落原始名，路径穿越/编码一并消除）。超限 413 半截清掉，伪装 415 不落盘。
 * 成功后跑 D35 文件预检（advisory，best-effort 不阻断）；返回存储名 + 预检结果。
 */
async function storeUpload(
  data: MultipartFile | undefined,
  uploadDir: string,
  target?: PrecheckTarget,
): Promise<{ storedName: string; precheck: PrecheckResult }> {
  if (!data) throw new OrderError(422, 'file_required')
  const ext = path.extname(data.filename ?? '').slice(1).toLowerCase()
  const kind = EXT_TO_KIND[ext]
  if (!kind) {
    // 排空流，否则连接挂起
    data.file.resume()
    throw new OrderError(415, 'unsupported_file_type')
  }

  await mkdir(uploadDir, { recursive: true })
  const storedName = `${randomUUID()}.${ext === 'tif' ? 'tiff' : ext}`
  const partPath = path.join(uploadDir, `${storedName}.part`)
  try {
    await pipeline(data.file, createWriteStream(partPath, { flags: 'wx' }))
  } catch (err) {
    await rm(partPath, { force: true })
    throw err
  }
  // 超过 limits.fileSize 时流被截断（不抛错）——半截文件清掉，413
  if (data.file.truncated) {
    await rm(partPath, { force: true })
    throw new OrderError(413, 'file_too_large')
  }

  // magic bytes 复查：以落盘内容为准（拒收改名伪装）
  const fh = await open(partPath, 'r')
  const head = Buffer.alloc(8)
  try {
    await fh.read(head, 0, 8, 0)
  } finally {
    await fh.close()
  }
  if (sniffMagic(head) !== kind) {
    await rm(partPath, { force: true })
    throw new OrderError(415, 'file_content_mismatch')
  }
  const finalPath = path.join(uploadDir, storedName)
  await rename(partPath, finalPath)
  const precheck = await precheckFile(finalPath, kind, target)
  return { storedName, precheck }
}

/** 经 randomUUID 存储名取下载流（basename 兜底防穿越）；缺文件/打不开 → 404 */
async function sendStored(reply: FastifyReply, uploadDir: string, fileUrl: string) {
  const safeName = path.basename(fileUrl)
  let fh
  try {
    fh = await open(path.join(uploadDir, safeName), 'r')
  } catch {
    throw new OrderError(404, 'not_found')
  }
  // attachment + nosniff：浏览器不内联渲染、不嗅探类型（上传内容不可执行/不可注入）
  void reply.header('content-disposition', `attachment; filename="${safeName}"`)
  void reply.header('x-content-type-options', 'nosniff')
  void reply.header('content-type', 'application/octet-stream')
  return reply.send(fh.createReadStream())
}

export function registerFilesRoutes(app: FastifyInstance, db: DB, uploadDir: string): void {
  const PARAMS_SCHEMA = {
    type: 'object',
    required: ['id', 'iid'],
    properties: { id: { type: 'string' }, iid: { type: 'string' } },
  }
  const COMP_PARAMS_SCHEMA = {
    type: 'object',
    required: ['id', 'cid'],
    properties: { id: { type: 'string' }, cid: { type: 'string' } },
  }

  const loadOwnedItem = (req: { user: { id: string; role: string } | null }, id: string, iid: string) => {
    const user = req.user as NonNullable<typeof req.user>
    const admin = user.role === 'admin'
    const order = getOrder(db, id)
    // 他人订单一律 404（§6 不泄露存在性）
    if (!order || (!admin && order.customer_id !== user.id)) throw new OrderError(404, 'not_found')
    const item = db
      .prepare('SELECT id, file_url FROM order_items WHERE id = ? AND order_id = ?')
      .get(iid, id) as { id: string; file_url: string | null } | undefined
    if (!item) throw new OrderError(404, 'not_found')
    return { order, item, admin }
  }

  /** D31 书组件归属：组件经 order_books 关联回订单，同 §6 他人 404 */
  const loadOwnedComponent = (req: { user: { id: string; role: string } | null }, id: string, cid: string) => {
    const user = req.user as NonNullable<typeof req.user>
    const admin = user.role === 'admin'
    const order = getOrder(db, id)
    if (!order || (!admin && order.customer_id !== user.id)) throw new OrderError(404, 'not_found')
    const comp = db
      .prepare(
        `SELECT obc.id, obc.file_url
         FROM order_book_components obc
         JOIN order_books ob ON ob.id = obc.order_book_id
         WHERE obc.id = ? AND ob.order_id = ?`,
      )
      .get(cid, id) as { id: string; file_url: string | null } | undefined
    if (!comp) throw new OrderError(404, 'not_found')
    return { order, comp, admin }
  }

  app.post(
    '/api/orders/:id/items/:iid/file',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: PARAMS_SCHEMA,
        response: { 201: ORDER_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA, 415: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id, iid } = req.params as { id: string; iid: string }
      const { order, item, admin } = loadOwnedItem(req, id, iid)
      if (!UPLOADABLE.includes(order.status)) {
        throw new OrderError(409, `not_uploadable_from_${order.status}`)
      }

      // D36 下单尺寸（mm）供预检尺寸/出血匹配（未配 mm → undefined 跳过）
      const target = db
        .prepare('SELECT s.width_mm, s.height_mm FROM order_items oi JOIN sizes s ON s.key = oi.size_key WHERE oi.id = ?')
        .get(iid) as PrecheckTarget | undefined
      const { storedName, precheck } = await storeUpload(await req.file(), uploadDir, target)

      // 重传：旧文件清理 + file_status 重置 pending、驳回意见清空、预检刷新（R5/D35 定点）
      if (item.file_url != null) {
        await rm(path.join(uploadDir, item.file_url), { force: true })
      }
      db.prepare(
        "UPDATE order_items SET file_url = ?, file_status = 'pending', file_note = NULL, file_precheck = ? WHERE id = ?",
      ).run(storedName, JSON.stringify(precheck), iid)
      const sync = syncFileState(db, id)
      // R7: 文件传齐进入审稿 → 通知 admin（分发永不抛错）
      if (sync.changed && sync.status === 'file_pending') {
        await notifyAdmins(db, 'order_file_pending', templates.orderFilePending(order.order_number))
      }

      const updated = getOrder(db, id) as OrderRow
      return reply.status(201).send(orderDto(db, updated, baseCurrency(db), { admin, includeToken: true }))
    },
  )

  app.get(
    '/api/orders/:id/items/:iid/file',
    {
      preHandler: requireUser,
      schema: { params: PARAMS_SCHEMA, response: { 404: ERROR_SCHEMA } },
    },
    async (req, reply) => {
      const { id, iid } = req.params as { id: string; iid: string }
      const { item } = loadOwnedItem(req, id, iid)
      if (item.file_url == null) throw new OrderError(404, 'not_found')
      return sendStored(reply, uploadDir, item.file_url)
    },
  )

  // ---------- D31 书组件级上传 / 下载（复用 R5 落盘 + 归属门） ----------

  app.post(
    '/api/orders/:id/book-components/:cid/file',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: COMP_PARAMS_SCHEMA,
        response: { 201: ORDER_SCHEMA, 404: ERROR_SCHEMA, 409: ERROR_SCHEMA, 415: ERROR_SCHEMA, 422: ERROR_SCHEMA },
      },
    },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string }
      const { order, comp, admin } = loadOwnedComponent(req, id, cid)
      if (!UPLOADABLE.includes(order.status)) {
        throw new OrderError(409, `not_uploadable_from_${order.status}`)
      }

      const target = db
        .prepare(
          'SELECT s.width_mm, s.height_mm FROM order_book_components obc JOIN sizes s ON s.key = obc.size_key WHERE obc.id = ?',
        )
        .get(cid) as PrecheckTarget | undefined
      const { storedName, precheck } = await storeUpload(await req.file(), uploadDir, target)

      if (comp.file_url != null) {
        await rm(path.join(uploadDir, comp.file_url), { force: true })
      }
      db.prepare(
        "UPDATE order_book_components SET file_url = ?, file_status = 'pending', file_note = NULL, file_precheck = ? WHERE id = ?",
      ).run(storedName, JSON.stringify(precheck), cid)
      const sync = syncFileState(db, id)
      if (sync.changed && sync.status === 'file_pending') {
        await notifyAdmins(db, 'order_file_pending', templates.orderFilePending(order.order_number))
      }

      const updated = getOrder(db, id) as OrderRow
      return reply.status(201).send(orderDto(db, updated, baseCurrency(db), { admin, includeToken: true }))
    },
  )

  app.get(
    '/api/orders/:id/book-components/:cid/file',
    {
      preHandler: requireUser,
      schema: { params: COMP_PARAMS_SCHEMA, response: { 404: ERROR_SCHEMA } },
    },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string }
      const { comp } = loadOwnedComponent(req, id, cid)
      if (comp.file_url == null) throw new OrderError(404, 'not_found')
      return sendStored(reply, uploadDir, comp.file_url)
    },
  )
}
