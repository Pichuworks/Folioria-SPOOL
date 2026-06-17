import { useEffect, useMemo, useState } from 'react'
import { fetchBookConfig, getBookConfigCache, type BookConfigDto, type BookConfigPaper } from './api'
import { Field, MagSec, SpecRow, specInput } from './spec'

const BLEED = 3

function parseGsm(paper: BookConfigPaper): number | null {
  if (paper.gsm) return paper.gsm
  const m = /(\d+)g/i.exec(paper.name)
  return m?.[1] ? parseInt(m[1], 10) : null
}

function thicknessPerSheet(gsm: number, name: string): number {
  if (/铜版|coated/i.test(name)) return gsm * 0.001
  if (/相纸|RC|baryta|艺术|微喷/i.test(name)) return gsm * 0.001
  return gsm * 0.00125
}

interface CoverDims {
  spine: number
  totalW: number
  totalH: number
  trimW: number
  trimH: number
  hasSpine: boolean
  thinSpine: boolean
}

function calcCover(
  trimW: number, trimH: number,
  sheets: number, mmPerSheet: number,
  binding: 'perfect' | 'saddle' | 'hardcover',
): CoverDims {
  const spine = sheets * mmPerSheet
  if (binding === 'saddle') {
    return {
      spine: 0, trimW, trimH,
      totalW: 2 * trimW + 2 * BLEED,
      totalH: trimH + 2 * BLEED,
      hasSpine: false, thinSpine: false,
    }
  }
  return {
    spine, trimW, trimH,
    totalW: 2 * trimW + spine + 2 * BLEED,
    totalH: trimH + 2 * BLEED,
    hasSpine: true,
    thinSpine: spine < 3,
  }
}

type BindingType = 'perfect' | 'saddle' | 'hardcover'
const BINDINGS: Array<{ key: BindingType; label: string }> = [
  { key: 'perfect', label: '无线胶装' },
  { key: 'saddle', label: '骑马钉' },
  { key: 'hardcover', label: '精装' },
]

function fmtNum(n: number): string { return +n.toFixed(2) + '' }

function generatePsScript(dims: CoverDims, binding: BindingType): string {
  const { totalW, totalH, spine, trimW, hasSpine } = dims
  const vGuides = [BLEED, totalW - BLEED]
  if (hasSpine) {
    vGuides.push(BLEED + trimW, BLEED + trimW + spine)
  } else {
    vGuides.push(BLEED + trimW)
  }
  vGuides.sort((a, b) => a - b)
  const hGuides = [BLEED, totalH - BLEED]

  const spineX = hasSpine ? BLEED + trimW + spine / 2 : totalW / 2
  const frontX = hasSpine ? BLEED + trimW + spine + trimW / 2 : BLEED + trimW + trimW / 2
  const backX = BLEED + trimW / 2

  const lines = [
    `var origUnits = app.preferences.rulerUnits;`,
    `app.preferences.rulerUnits = Units.MM;`,
    `var resolution = 300;`,
    `var pageW = ${fmtNum(totalW)};`,
    `var pageH = ${fmtNum(totalH)};`,
    `var docRef = app.documents.add(pageW, pageH, resolution, "封面", NewDocumentMode.CMYK, DocumentFill.TRANSPARENT);`,
    `var doc = app.activeDocument;`,
    ``,
    `var LY = [${vGuides.map(fmtNum).join(',')}];`,
    `var LX = [${hGuides.map(fmtNum).join(',')}];`,
    `for (var i = 0; i < LY.length; i++) doc.guides.add(Direction.VERTICAL, LY[i]);`,
    `for (var i = 0; i < LX.length; i++) doc.guides.add(Direction.HORIZONTAL, LX[i]);`,
  ]

  const addLabel = (name: string, layerName: string, x: number, fontSize: number, vertical: boolean) => {
    lines.push(``)
    lines.push(`var tl = doc.artLayers.add();`)
    lines.push(`tl.kind = LayerKind.TEXT;`)
    lines.push(`tl.name = "${layerName}";`)
    lines.push(`var ti = tl.textItem;`)
    lines.push(`ti.font = "Arial";`)
    lines.push(`ti.size = ${fontSize};`)
    lines.push(`ti.color.cmyk.cyan = 0; ti.color.cmyk.magenta = 0; ti.color.cmyk.yellow = 0; ti.color.cmyk.black = 30;`)
    if (vertical) {
      const text = name.split('').join('\\r')
      lines.push(`ti.contents = "${text}";`)
      lines.push(`ti.position = [${x} - ${fontSize} * 0.4, pageH / 2 - ${name.length} * ${fontSize} * 0.5];`)
    } else {
      lines.push(`ti.contents = "${name}";`)
      lines.push(`ti.position = [${x} - ti.contents.length * ${fontSize} * 0.35, pageH / 2 - ${fontSize} * 0.5];`)
    }
  }

  addLabel('封面', '封面位置', frontX, 24, false)
  addLabel('封底', '封底位置', backX, 24, false)
  if (hasSpine && !dims.thinSpine) {
    addLabel('书脊', '书脊位置', spineX, Math.min(spine * 0.6, 14), true)
  }

  lines.push(``)
  lines.push(`app.preferences.rulerUnits = origUnits;`)

  return lines.join('\n')
}

function CoverDiagram({ dims, binding }: { dims: CoverDims; binding: BindingType }) {
  const { totalW, totalH, spine, trimW, hasSpine } = dims
  const scale = Math.min(520 / totalW, 260 / totalH)
  const w = totalW * scale
  const h = totalH * scale
  const b = BLEED * scale
  const tw = trimW * scale
  const sw = spine * scale

  return (
    <svg viewBox={`0 0 ${w + 40} ${h + 56}`} className="mx-auto w-full max-w-[580px]" role="img" aria-label="封面展开示意图">
      <defs>
        <pattern id="bleed-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="stroke-wine-dim/30" strokeWidth="1" />
        </pattern>
        <marker id="arr" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto">
          <path d="M0,0 L4,2 L0,4" className="fill-dim" />
        </marker>
      </defs>
      <g transform="translate(20, 28)">
        {/* bleed area */}
        <rect x={0} y={0} width={w} height={h} fill="url(#bleed-hatch)" className="stroke-line" strokeWidth="0.5" strokeDasharray="4 2" />
        {/* trim area */}
        <rect x={b} y={b} width={w - 2 * b} height={h - 2 * b} className="fill-card stroke-ink" strokeWidth="1" />
        {/* spine */}
        {hasSpine && sw > 0 && (
          <rect x={b + tw} y={b} width={sw} height={h - 2 * b} className="fill-wine-dim/20 stroke-wine" strokeWidth="0.8" strokeDasharray="3 2" />
        )}
        {/* fold line for saddle stitch */}
        {!hasSpine && (
          <line x1={b + tw} y1={b} x2={b + tw} y2={h - b} className="stroke-wine" strokeWidth="0.8" strokeDasharray="4 3" />
        )}
        {/* labels */}
        <text x={b + tw / 2} y={h / 2} textAnchor="middle" dominantBaseline="central" className="fill-dim text-[11px]">封底</text>
        <text x={hasSpine ? b + tw + sw + tw / 2 : b + tw + tw / 2} y={h / 2} textAnchor="middle" dominantBaseline="central" className="fill-dim text-[11px]">封面</text>
        {hasSpine && sw > 12 && (
          <text x={b + tw + sw / 2} y={h / 2} textAnchor="middle" dominantBaseline="central" className="fill-wine-ink text-[9px]" writingMode="vertical-rl">书脊</text>
        )}
        {/* dimension: total width */}
        <line x1={0} y1={h + 10} x2={w} y2={h + 10} className="stroke-dim" strokeWidth="0.5" markerEnd="url(#arr)" markerStart="url(#arr)" />
        <text x={w / 2} y={h + 22} textAnchor="middle" className="fill-dim text-[9px] font-mono">{+totalW.toFixed(2)}mm</text>
        {/* dimension: height */}
        <line x1={w + 8} y1={0} x2={w + 8} y2={h} className="stroke-dim" strokeWidth="0.5" />
        <text x={w + 12} y={h / 2} textAnchor="start" dominantBaseline="central" className="fill-dim text-[9px] font-mono" transform={`rotate(90, ${w + 12}, ${h / 2})`}>{totalH}mm</text>
        {/* bleed label */}
        <text x={b / 2} y={-6} textAnchor="middle" className="fill-wine-ink text-[8px]">{BLEED}</text>
        <text x={w - b / 2} y={-6} textAnchor="middle" className="fill-wine-ink text-[8px]">{BLEED}</text>
      </g>
    </svg>
  )
}

export default function CoverSize() {
  const [cfg, setCfg] = useState<BookConfigDto | null>(getBookConfigCache)
  const [error, setError] = useState<string | null>(null)

  const [sizeKey, setSizeKey] = useState<string>('A5')
  const [paperId, setPaperId] = useState<number | null>(null)
  const [pages, setPages] = useState(100)
  const [binding, setBinding] = useState<BindingType>('perfect')

  useEffect(() => {
    let cancelled = false
    fetchBookConfig()
      .then((c) => { if (!cancelled) setCfg(c) })
      .catch(() => { if (!cancelled && !getBookConfigCache()) setError('数据加载失败') })
    return () => { cancelled = true }
  }, [])

  const sizes = cfg?.sizes.filter((s) => s.width_mm && s.height_mm) ?? []
  const papers = cfg?.papers ?? []

  const innerPapers = useMemo(() => {
    return papers.filter((p) => parseGsm(p) !== null)
  }, [papers])

  const selectedSize = sizes.find((s) => s.key === sizeKey)
  const selectedPaper = innerPapers.find((p) => p.id === paperId)

  const sheets = Math.ceil(pages / 2)

  const dims = useMemo(() => {
    if (!selectedSize?.width_mm || !selectedSize?.height_mm) return null
    if (!selectedPaper) return null
    const gsm = parseGsm(selectedPaper)
    if (!gsm) return null
    const mmPS = thicknessPerSheet(gsm, selectedPaper.name)
    return calcCover(selectedSize.width_mm, selectedSize.height_mm, sheets, mmPS, binding)
  }, [selectedSize, selectedPaper, sheets, binding])

  const download = () => {
    if (!dims) return
    const script = generatePsScript(dims, binding)
    const blob = new Blob([script], { type: 'text/javascript;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `封面模板_${sizeKey}_${+dims.totalW.toFixed(2)}x${+dims.totalH.toFixed(2)}mm.jsx`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (error) return <p className="py-20 text-center text-wine-ink">{error}</p>

  const pillBtn = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-[12.5px] transition-opacity ${
      active ? 'border-wine bg-wine text-cream' : 'border-line text-dim hover:text-ink'
    }`

  return (
    <div className="mx-auto max-w-2xl">
      <MagSec tag="TOOL" title="封面尺寸计算">
        <p className="mb-8 text-[13.5px] leading-relaxed text-dim">
          根据内页数量和纸张，计算书籍封面的展开尺寸。可下载 Photoshop 模板（.jsx 脚本），在 PS 中直接打开即可生成带参考线的封面文档。
        </p>

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          {/* left: inputs */}
          <div className="space-y-5">
            <Field label="成品尺寸">
              <select className={specInput} value={sizeKey} onChange={(e) => setSizeKey(e.target.value)}>
                {sizes.map((s) => (
                  <option key={s.key} value={s.key}>{s.label} {s.width_mm}×{s.height_mm}mm</option>
                ))}
              </select>
            </Field>

            <Field label="内页纸张">
              <select
                className={specInput}
                value={paperId ?? ''}
                onChange={(e) => setPaperId(e.target.value === '' ? null : Number(e.target.value))}
              >
                <option value="">— 选择纸张 —</option>
                {innerPapers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.gsm ? ` ${p.gsm}g` : ''}</option>
                ))}
              </select>
            </Field>

            <Field label="内页数量（P，即面数）">
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={1}
                  className={specInput}
                  value={pages}
                  onChange={(e) => setPages(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
                />
                <span className="shrink-0 text-[12.5px] text-dim">共 {sheets} 张纸</span>
              </div>
            </Field>

            <div>
              <span className="mb-1.5 block text-[12px] tracking-[.06em] text-dim">装订方式</span>
              <div className="flex flex-wrap gap-2">
                {BINDINGS.map((b) => (
                  <button key={b.key} type="button" className={pillBtn(binding === b.key)} onClick={() => setBinding(b.key)}>
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* right: result */}
          <div>
            {dims ? (
              <div className="space-y-0">
                <SpecRow label="书脊厚度" value={
                  dims.hasSpine
                    ? <>{dims.spine.toFixed(2)}mm{dims.thinSpine && <span className="ml-2 text-[11px] text-wine-ink">较窄，不建议添加书脊文字</span>}</>
                    : <span className="text-dim">骑马钉无书脊</span>
                } />
                <SpecRow label="展开宽度" strong value={
                  dims.hasSpine
                    ? <>{dims.trimW}<span className="text-dim">+{dims.spine.toFixed(2)}+</span>{dims.trimW}<span className="text-dim">+{2 * BLEED}出血</span> = {+dims.totalW.toFixed(2)}mm</>
                    : <>{dims.trimW}<span className="text-dim">+</span>{dims.trimW}<span className="text-dim">+{2 * BLEED}出血</span> = {dims.totalW}mm</>
                } />
                <SpecRow label="展开高度" value={<>{dims.trimH}<span className="text-dim">+{2 * BLEED}出血</span> = {dims.totalH}mm</>} />
                <SpecRow label="出血" value={`${BLEED}mm（四边）`} />
                <SpecRow label="分辨率" value="300 DPI · CMYK" />
                {binding === 'hardcover' && (
                  <p className="mt-3 text-[11.5px] leading-relaxed text-wine-ink">
                    ⚠ 精装封面需额外考虑纸板厚度（约 2mm）和包边余量（约 15mm），此处仅计算书芯展开尺寸，实际封面用纸需另行计算。
                  </p>
                )}
              </div>
            ) : (
              <p className="py-8 text-center text-[13px] text-dim">选择纸张后显示尺寸。</p>
            )}
          </div>
        </div>

        {/* diagram */}
        {dims && (
          <div className="mt-10 border-t border-line pt-8">
            <span className="mb-4 block text-[11px] font-medium tracking-[.06em] text-dim">展开示意图</span>
            <CoverDiagram dims={dims} binding={binding} />
          </div>
        )}

        {/* download */}
        {dims && (
          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={download}
              className="inline-flex items-center gap-2 rounded-full border border-wine bg-wine px-6 py-2.5 text-[14px] font-medium text-cream shadow-e1 transition-opacity hover:opacity-90"
            >
              下载 Photoshop 模板
              <span className="text-[11px] opacity-70">.jsx</span>
            </button>
          </div>
        )}

        <p className="mt-8 text-[11.5px] leading-relaxed text-dim">
          提示：下载的 .jsx 文件需在 Photoshop 中通过「文件 → 脚本 → 浏览」打开，请先确保 PS 默认单位已设为毫米。书脊厚度为根据克重估算值，实际厚度因纸张批次略有差异，建议以印刷实样为准。
        </p>
      </MagSec>
    </div>
  )
}
