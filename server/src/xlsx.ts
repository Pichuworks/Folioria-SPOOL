import ExcelJS from 'exceljs'
import { type FastifyReply } from 'fastify'

export async function sendXlsx(
  reply: FastifyReply,
  filename: string,
  sheets: Array<{ name: string; columns: Array<{ header: string; key: string; width?: number }>; rows: unknown[] }>,
): Promise<void> {
  const wb = new ExcelJS.Workbook()
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name)
    ws.columns = s.columns
    for (const r of s.rows) ws.addRow(r)
    ws.getRow(1).font = { bold: true }
  }
  const buf = await wb.xlsx.writeBuffer()
  void reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  void reply.header('content-disposition', `attachment; filename="${filename}"`)
  return reply.send(Buffer.from(buf as ArrayBuffer))
}
