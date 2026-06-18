import ExcelJS from 'exceljs'
import { type FastifyReply } from 'fastify'

// review M2 / CWE-1236 公式注入：以 = + - @ Tab CR 开头的文本被电子表格客户端当公式执行，
// 用户可控字段（name/notes/supplier/reason 等）经导出可对打开者投毒。写入前对字符串前置单引号
// （强制文本，客户端隐藏该引号），仅作用于 string，null/number 原样通过。
const FORMULA_LEAD = /^[=+\-@\t\r]/
const neutralize = (v: unknown): unknown =>
  typeof v === 'string' && FORMULA_LEAD.test(v) ? `'${v}` : v
function sanitizeRow(r: unknown): unknown {
  if (r == null || typeof r !== 'object') return neutralize(r)
  if (Array.isArray(r)) return r.map(neutralize)
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(r)) out[k] = neutralize(val)
  return out
}

export async function sendXlsx(
  reply: FastifyReply,
  filename: string,
  sheets: Array<{ name: string; columns: Array<{ header: string; key: string; width?: number }>; rows: unknown[] }>,
): Promise<void> {
  const wb = new ExcelJS.Workbook()
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name)
    ws.columns = s.columns
    for (const r of s.rows) ws.addRow(sanitizeRow(r))
    ws.getRow(1).font = { bold: true }
  }
  const buf = await wb.xlsx.writeBuffer()
  void reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  void reply.header('content-disposition', `attachment; filename="${filename}"`)
  return reply.send(Buffer.from(buf as ArrayBuffer))
}
