import { readFile, stat } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'

/**
 * D35 文件自动预检（advisory，best-effort，永不阻断）：上传落盘后跑，结果存 file_precheck JSON。
 * 图片走 sharp 元数据（DPI/色彩空间/像素尺寸）；PDF 走 pdf-lib（页数/加密/首页尺寸）。
 * 注：sizes 表只有相对 area、无绝对 mm，故暂只「报告」文件尺寸，不做「vs 订单尺寸 + 出血」匹配（留 follow-up）。
 */

export type PrecheckLevel = 'ok' | 'info' | 'warn'
export interface PrecheckItem {
  key: string
  level: PrecheckLevel
  message: string
}
export interface PrecheckResult {
  level: PrecheckLevel
  items: PrecheckItem[]
}

const MIN_DPI = 300
/** 超过此大小的 PDF 跳过解析（pdf-lib 全量载入内存，避免大文件内存尖峰） */
const PDF_PARSE_MAX_BYTES = 64 * 1024 * 1024

const SEVERITY: Record<PrecheckLevel, number> = { ok: 0, info: 1, warn: 2 }
const worst = (items: PrecheckItem[]): PrecheckLevel =>
  items.reduce<PrecheckLevel>((acc, i) => (SEVERITY[i.level] > SEVERITY[acc] ? i.level : acc), 'ok')

const ptToMm = (pt: number): number => Math.round((pt / 72) * 25.4)

async function precheckImage(filePath: string): Promise<PrecheckResult> {
  // limitInputPixels:false 仅为读元数据放开像素上限（不解码像素，header-only，快且省内存）
  const meta = await sharp(filePath, { limitInputPixels: false }).metadata()
  const items: PrecheckItem[] = []
  const dpi = meta.density
  if (dpi == null || dpi <= 1) {
    items.push({ key: 'dpi', level: 'info', message: '未含分辨率信息（DPI 未知，请确认导出含 DPI）' })
  } else if (dpi < MIN_DPI) {
    items.push({ key: 'dpi', level: 'warn', message: `分辨率偏低 ${dpi} dpi（印刷建议 ≥ ${MIN_DPI}）` })
  } else {
    items.push({ key: 'dpi', level: 'ok', message: `分辨率 ${dpi} dpi` })
  }
  if (meta.width && meta.height) {
    items.push({ key: 'dimensions', level: 'info', message: `像素尺寸 ${meta.width}×${meta.height}` })
  }
  if (meta.space) {
    // 艺术微喷常用 RGB，故色彩空间仅作 info 报告，不判警告
    items.push({ key: 'colorspace', level: 'info', message: `色彩空间 ${meta.space.toUpperCase()}` })
  }
  return { level: worst(items), items }
}

async function precheckPdf(filePath: string): Promise<PrecheckResult> {
  const { size } = await stat(filePath)
  if (size > PDF_PARSE_MAX_BYTES) {
    return { level: 'info', items: [{ key: 'size', level: 'info', message: '文件较大，已存盘但跳过 PDF 预检' }] }
  }
  const bytes = await readFile(filePath)
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const items: PrecheckItem[] = []
  if (doc.isEncrypted) {
    items.push({ key: 'encrypted', level: 'warn', message: 'PDF 已加密，请提供未加密版本以便印刷' })
  }
  const pages = doc.getPageCount()
  if (pages > 0) {
    items.push({ key: 'pages', level: 'info', message: `共 ${pages} 页` })
    const { width, height } = doc.getPage(0).getSize()
    items.push({ key: 'page_size', level: 'info', message: `首页 ${ptToMm(width)}×${ptToMm(height)}mm` })
  } else {
    items.push({ key: 'pages', level: 'warn', message: '无可读页面' })
  }
  return { level: worst(items), items }
}

/** 落盘文件预检入口。任何解析失败都收敛为 warn（不抛错，上传已成功，仅提示人工复核） */
export async function precheckFile(filePath: string, kind: 'pdf' | 'png' | 'tiff'): Promise<PrecheckResult> {
  try {
    return kind === 'pdf' ? await precheckPdf(filePath) : await precheckImage(filePath)
  } catch {
    return {
      level: 'warn',
      items: [{ key: 'parse', level: 'warn', message: '文件无法完整解析（可能损坏或格式异常），请确认导出正常' }],
    }
  }
}
