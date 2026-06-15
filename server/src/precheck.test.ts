import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { precheckFile } from './precheck.js'

/** D35 文件预检：advisory，best-effort（DPI/色彩空间/页数/加密/可解析），永不阻断。 */

let dir: string
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'spool-precheck-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function pngAt(dpi: number): Promise<string> {
  const buf = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ffffff' } })
    .withMetadata({ density: dpi })
    .png()
    .toBuffer()
  const p = path.join(dir, `img-${dpi}.png`)
  writeFileSync(p, buf)
  return p
}

describe('D35 文件预检', () => {
  it('低 DPI 图片 → warn dpi', async () => {
    const r = await precheckFile(await pngAt(150), 'png')
    expect(r.level).toBe('warn')
    expect(r.items.find((i) => i.key === 'dpi')?.level).toBe('warn')
  })

  it('≥300 DPI 图片 → dpi ok；尺寸/色彩空间作 info', async () => {
    const r = await precheckFile(await pngAt(300), 'png')
    expect(r.items.find((i) => i.key === 'dpi')?.level).toBe('ok')
    expect(r.items.find((i) => i.key === 'dimensions')?.message).toContain('120×80')
    expect(r.items.find((i) => i.key === 'colorspace')?.level).toBe('info')
    expect(r.level).toBe('info') // 最高仅 info，不误报警告
  })

  it('正常 PDF → info（页数 + 首页 mm 尺寸）', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([595.28, 841.89]) // A4 points
    const p = path.join(dir, 'a4.pdf')
    writeFileSync(p, await doc.save())
    const r = await precheckFile(p, 'pdf')
    expect(r.level).toBe('info')
    expect(r.items.find((i) => i.key === 'pages')?.message).toContain('1 页')
    expect(r.items.find((i) => i.key === 'page_size')?.message).toMatch(/210×297mm/)
  })

  it('损坏 PDF（magic 过但解析失败）→ warn parse，不抛错', async () => {
    const p = path.join(dir, 'broken.pdf')
    writeFileSync(p, '%PDF-1.4 not really a pdf body')
    const r = await precheckFile(p, 'pdf')
    expect(r.level).toBe('warn')
    expect(r.items.find((i) => i.key === 'parse')?.level).toBe('warn')
  })
})

describe('D36 尺寸/出血匹配', () => {
  async function pdfAt(wPt: number, hPt: number, name: string): Promise<string> {
    const doc = await PDFDocument.create()
    doc.addPage([wPt, hPt])
    const p = path.join(dir, name)
    writeFileSync(p, await doc.save())
    return p
  }
  const mmToPt = (mm: number) => (mm / 25.4) * 72
  const A4 = { width_mm: 210, height_mm: 297 }

  it('PDF 恰好下单尺寸 → size info「未见出血」', async () => {
    const r = await precheckFile(await pdfAt(mmToPt(210), mmToPt(297), 'exact.pdf'), 'pdf', A4)
    const sz = r.items.find((i) => i.key === 'size')
    expect(sz?.level).toBe('info')
    expect(sz?.message).toContain('未见出血')
  })

  it('PDF 含 3mm 出血（216×303）→ size ok「含出血」', async () => {
    const r = await precheckFile(await pdfAt(mmToPt(216), mmToPt(303), 'bleed.pdf'), 'pdf', A4)
    const sz = r.items.find((i) => i.key === 'size')
    expect(sz?.level).toBe('ok')
    expect(sz?.message).toContain('含出血')
  })

  it('PDF 尺寸不符（A4 文件 vs A3 下单）→ size warn，整体 warn', async () => {
    const r = await precheckFile(await pdfAt(mmToPt(210), mmToPt(297), 'a4.pdf'), 'pdf', { width_mm: 297, height_mm: 420 })
    const sz = r.items.find((i) => i.key === 'size')
    expect(sz?.level).toBe('warn')
    expect(r.level).toBe('warn')
  })

  it('orientation-agnostic：横向文件对纵向下单仍匹配', async () => {
    const r = await precheckFile(await pdfAt(mmToPt(297), mmToPt(210), 'landscape.pdf'), 'pdf', A4)
    expect(r.items.find((i) => i.key === 'size')?.level).toBe('info') // 长短边比对，方向无关
  })

  it('target 为 NULL（未配 mm）→ 不产 size 项（回退仅报告尺寸）', async () => {
    const r = await precheckFile(await pdfAt(mmToPt(210), mmToPt(297), 'noTarget.pdf'), 'pdf', { width_mm: null, height_mm: null })
    expect(r.items.find((i) => i.key === 'size')).toBeUndefined()
    expect(r.items.find((i) => i.key === 'page_size')).toBeTruthy() // 尺寸仍报告
  })

  it('图片按 px÷DPI 比对：300×300@300dpi=25mm 对 target 25mm → info', async () => {
    const buf = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#fff' } })
      .withMetadata({ density: 300 })
      .png()
      .toBuffer()
    const p = path.join(dir, 'sq.png')
    writeFileSync(p, buf)
    const r = await precheckFile(p, 'png', { width_mm: 25, height_mm: 25 })
    expect(r.items.find((i) => i.key === 'size')?.level).toBe('info')
  })
})
