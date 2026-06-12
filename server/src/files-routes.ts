import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { type FastifyInstance } from 'fastify'
import { baseCurrency } from './currency.js'
import { type DB } from './db.js'
import { requireUser } from './guards.js'
import { getOrder, getOrderItems, OrderError, syncFileState, type OrderRow } from './orders.js'
import { ERROR_SCHEMA, ORDER_SCHEMA, orderDto } from './orders-routes.js'

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

export function registerFilesRoutes(app: FastifyInstance, db: DB, uploadDir: string): void {
  const PARAMS_SCHEMA = {
    type: 'object',
    required: ['id', 'iid'],
    properties: { id: { type: 'string' }, iid: { type: 'string' } },
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

      const data = await req.file()
      if (!data) throw new OrderError(422, 'file_required')
      const ext = path.extname(data.filename ?? '').slice(1).toLowerCase()
      const kind = EXT_TO_KIND[ext]
      if (!kind) {
        // 排空流，否则连接挂起
        data.file.resume()
        throw new OrderError(415, 'unsupported_file_type')
      }

      await mkdir(uploadDir, { recursive: true })
      // randomUUID 文件名：不落原始文件名（路径穿越/编码问题一并消除），扩展名取白名单内规范值
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
      await rename(partPath, path.join(uploadDir, storedName))

      // 重传：旧文件清理 + file_status 重置 pending、驳回意见清空（R5 定点）
      if (item.file_url != null) {
        await rm(path.join(uploadDir, item.file_url), { force: true })
      }
      db.prepare("UPDATE order_items SET file_url = ?, file_status = 'pending', file_note = NULL WHERE id = ?").run(
        storedName,
        iid,
      )
      syncFileState(db, id)

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
      // 存储名经 randomUUID 生成，不含路径段；basename 兜底防穿越
      const safeName = path.basename(item.file_url)
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
    },
  )
}
