import { readFile, stat } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { getLog } from './logger.js'

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

/** D36 下单尺寸（绝对 mm）；任一为 NULL（未配 mm）则跳过尺寸匹配 */
export interface PrecheckTarget {
  width_mm: number | null
  height_mm: number | null
}

const MIN_DPI = 300
const BLEED_MM = 3
const SIZE_EXACT_TOL_MM = 2 // 与目标吻合容差（含出血判定）
const BLEED_SLACK_MM = 4 * BLEED_MM // 出血上限松弛（每边最多 ~2×bleed）
/** 超过此大小的 PDF 跳过解析（pdf-lib 全量载入内存，避免大文件内存尖峰） */
const PDF_PARSE_MAX_BYTES = 64 * 1024 * 1024

const SEVERITY: Record<PrecheckLevel, number> = { ok: 0, info: 1, warn: 2 }
const worst = (items: PrecheckItem[]): PrecheckLevel =>
  items.reduce<PrecheckLevel>((acc, i) => (SEVERITY[i.level] > SEVERITY[acc] ? i.level : acc), 'ok')

const ptToMm = (pt: number): number => Math.round((pt / 72) * 25.4)

/**
 * D36 文件物理尺寸 vs 下单尺寸（orientation-agnostic：长边比长边、短边比短边）。
 * 含出血(目标..目标+slack)→ok；吻合(±tol)→info 提示补出血；超界→warn。target 不全则返回 null（跳过）。
 */
function sizeCheck(fileWmm: number, fileHmm: number, target: PrecheckTarget | undefined): PrecheckItem | null {
  if (!target || target.width_mm == null || target.height_mm == null) return null
  const fLong = Math.max(fileWmm, fileHmm)
  const fShort = Math.min(fileWmm, fileHmm)
  const tLong = Math.max(target.width_mm, target.height_mm)
  const tShort = Math.min(target.width_mm, target.height_mm)
  const dLong = fLong - tLong
  const dShort = fShort - tShort
  const inBand = (d: number) => d >= -SIZE_EXACT_TOL_MM && d <= BLEED_SLACK_MM
  const label = `${tLong}×${tShort}mm`
  if (inBand(dLong) && inBand(dShort)) {
    if (Math.abs(dLong) <= SIZE_EXACT_TOL_MM && Math.abs(dShort) <= SIZE_EXACT_TOL_MM) {
      return { key: 'size', level: 'info', message: `尺寸吻合 ${label}，未见出血（建议每边 +${BLEED_MM}mm）` }
    }
    return { key: 'size', level: 'ok', message: `尺寸匹配（含出血，下单 ${label}）` }
  }
  return { key: 'size', level: 'warn', message: `文件 ${fLong}×${fShort}mm 与下单尺寸 ${label} 不符` }
}

async function precheckImage(filePath: string, target?: PrecheckTarget): Promise<PrecheckResult> {
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
    // 物理尺寸 = 像素 ÷ DPI（仅 DPI 已知时可比对下单尺寸）
    if (dpi != null && dpi > 1) {
      const sc = sizeCheck(Math.round((meta.width / dpi) * 25.4), Math.round((meta.height / dpi) * 25.4), target)
      if (sc) items.push(sc)
    }
  }
  if (meta.space) {
    // 艺术微喷常用 RGB，故色彩空间仅作 info 报告，不判警告
    items.push({ key: 'colorspace', level: 'info', message: `色彩空间 ${meta.space.toUpperCase()}` })
  }
  return { level: worst(items), items }
}

async function precheckPdf(filePath: string, target?: PrecheckTarget): Promise<PrecheckResult> {
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
    const wmm = ptToMm(width)
    const hmm = ptToMm(height)
    items.push({ key: 'page_size', level: 'info', message: `首页 ${wmm}×${hmm}mm` })
    const sc = sizeCheck(wmm, hmm, target)
    if (sc) items.push(sc)
  } else {
    items.push({ key: 'pages', level: 'warn', message: '无可读页面' })
  }
  return { level: worst(items), items }
}

/** 落盘文件预检入口。任何解析失败都收敛为 warn（不抛错，上传已成功，仅提示人工复核） */
export async function precheckFile(
  filePath: string,
  kind: 'pdf' | 'png' | 'tiff',
  target?: PrecheckTarget,
): Promise<PrecheckResult> {
  try {
    return kind === 'pdf' ? await precheckPdf(filePath, target) : await precheckImage(filePath, target)
  } catch (err) {
    getLog().warn({ err, filePath, kind }, 'precheck parse failed')
    return {
      level: 'warn',
      items: [{ key: 'parse', level: 'warn', message: '文件无法完整解析（可能损坏或格式异常），请确认导出正常' }],
    }
  }
}
