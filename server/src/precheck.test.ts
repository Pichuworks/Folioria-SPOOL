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
