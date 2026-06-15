import { useRef, useMemo, useState, type FormEvent } from 'react'
import { send } from '../api'
import { Field, Leader, Paginator, PillBtn, specInput, usePagination } from '../spec'
import {
  actionBtn,
  FILTER_OPTIONS,
  FLAG_BG,
  FLAG_STYLE,
  type ComboDto,
  type ModeDto,
  type PaperDto,
  type QuoteDto,
  type SizeDto,
} from './types'

interface QuoteRow {
  key: string
  mode_id: number
  paper_id: number
  cells: Map<string, QuoteDto>
}

function PriceEditPanel({
  combo,
  quote,
  onDone,
}: {
  combo: ComboDto
  quote: QuoteDto
  onDone: () => void
}) {
  const existing = combo.prices.find((p) => p.size_key === quote.size_key)
  const [sell, setSell] = useState(existing?.sell_c == null ? '' : String(existing.sell_c))
  const [internal, setInternal] = useState(existing?.internal_sell_c == null ? '' : String(existing.internal_sell_c))
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const parse = (v: string): number | null | false => {
      if (v.trim() === '') return null
      const n = Number(v)
      return Number.isSafeInteger(n) && n >= 0 ? n : false
    }
    const s = parse(sell)
    const i = parse(internal)
    if (s === false || i === false) {
      setError('价格须为非负整数（_c）')
      return
    }
    const res = await send('PUT', `/api/pricing/combos/${combo.id}/prices/${quote.size_key}`, {
      sell_c: s,
      internal_sell_c: i,
    })
    if (res.ok) onDone()
    else setError('保存失败')
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3 border border-line bg-card p-3.5">
      <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">
        {quote.size_key} · 墨耗 {quote.ink_display} + 纸张 {quote.paper_display} = 成本 {quote.total_display} · 地板 {quote.auto_display}
      </span>
      <Field label="手动售价 _c（留空 = 自动地板价）">
        <input type="number" min={0} className={specInput} value={sell} onChange={(e) => setSell(e.target.value)} />
      </Field>
      <Field label="内部价 _c（留空 = 同对外）">
        <input type="number" min={0} className={specInput} value={internal} onChange={(e) => setInternal(e.target.value)} />
      </Field>
      <PillBtn>保存</PillBtn>
      {error && <p className="w-full text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

function AddComboForm({
  modes,
  papers,
  onChanged,
}: {
  modes: ModeDto[]
  papers: PaperDto[]
  onChanged: () => void
}) {
  const [modeId, setModeId] = useState('')
  const [paperId, setPaperId] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (modeId === '' || paperId === '') return
    const res = await send('POST', '/api/pricing/combos', {
      mode_id: Number(modeId),
      paper_id: Number(paperId),
    })
    if (res.ok) {
      setNotice('组合已建——有纸张口径的尺寸即时可报价')
      setModeId('')
      setPaperId('')
      onChanged()
    } else {
      setNotice(res.status === 409 ? '该组合已存在' : '创建失败')
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mb-5 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
      <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW COMBO</span>
      <Field label="打印模式">
        <select className={specInput} value={modeId} onChange={(e) => setModeId(e.target.value)}>
          <option value="">— 选择 —</option>
          {modes
            .filter((m) => m.archived === 0)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="纸张">
        <select className={specInput} value={paperId} onChange={(e) => setPaperId(e.target.value)}>
          <option value="">— 选择 —</option>
          {papers
            .filter((p) => p.archived === 0)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </Field>
      <PillBtn>新增组合</PillBtn>
      {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
    </form>
  )
}

export default function QuotesTab({
  quotes,
  combos,
  modes,
  papers,
  sizes,
  onChanged,
}: {
  quotes: QuoteDto[]
  combos: ComboDto[]
  modes: ModeDto[]
  papers: PaperDto[]
  sizes: SizeDto[]
  onChanged: () => void
}) {
  const [search, setSearch] = useState('')
  const [flagFilter, setFlagFilter] = useState('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ updated: number; skipped: { row: number; reason: string }[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const modeName = useMemo(() => new Map(modes.map((m) => [m.id, m.name])), [modes])
  const paperName = useMemo(() => new Map(papers.map((p) => [p.id, p.name])), [papers])
  const comboBy = useMemo(() => new Map(combos.map((c) => [`${c.mode_id}:${c.paper_id}`, c])), [combos])

  const rows: QuoteRow[] = useMemo(() => {
    const map = new Map<string, QuoteRow>()
    for (const q of quotes) {
      const key = `${q.mode_id}:${q.paper_id}`
      let row = map.get(key)
      if (!row) {
        row = { key, mode_id: q.mode_id, paper_id: q.paper_id, cells: new Map() }
        map.set(key, row)
      }
      row.cells.set(q.size_key, q)
    }
    return [...map.values()]
  }, [quotes])

  const filtered = useMemo(() => {
    let result = rows
    if (search.trim()) {
      const s = search.toLowerCase()
      result = result.filter(
        (r) =>
          (modeName.get(r.mode_id) ?? '').toLowerCase().includes(s) ||
          (paperName.get(r.paper_id) ?? '').toLowerCase().includes(s),
      )
    }
    if (flagFilter !== 'all') {
      result = result.filter((r) => [...r.cells.values()].some((q) => q.flag === flagFilter))
    }
    return result
  }, [rows, search, flagFilter, modeName, paperName])

  const { page, totalPages, paged, setPage } = usePagination(filtered, 20)

  const editingQuote = useMemo(() => {
    if (!editing) return null
    const [mId, pId, sKey] = editing.split(':')
    const row = rows.find((r) => r.key === `${mId}:${pId}`)
    const q = row?.cells.get(sKey!)
    const combo = comboBy.get(`${mId}:${pId}`)
    return q && combo ? { quote: q, combo } : null
  }, [editing, rows, comboBy])

  const archiveCombo = async (combo: ComboDto) => {
    if (!window.confirm('归档该组合？其全部尺寸将从报价中下架。')) return
    const res = await send('PATCH', `/api/pricing/combos/${combo.id}`, { archived: true })
    if (res.ok) onChanged()
  }

  const handleImport = async (file: File) => {
    setImporting(true)
    setImportResult(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/admin/pricing/import', { method: 'POST', body: form })
      const data = await res.json() as { updated: number; skipped: { row: number; reason: string }[] }
      setImportResult(data)
      if (res.ok && data.updated > 0) onChanged()
    } catch {
      setImportResult({ updated: 0, skipped: [{ row: 0, reason: '上传失败' }] })
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-4 pt-5">
        <input
          type="text"
          placeholder="搜索模式 / 纸张…"
          className="w-48 border border-line bg-card px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-dim/60 focus:border-wine"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-1">
          {FILTER_OPTIONS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFlagFilter(flagFilter === f.key ? 'all' : f.key)}
              className={`px-2.5 py-1 font-mono text-[10px] tracking-[.1em] ${
                flagFilter === f.key
                  ? 'bg-ink text-paper'
                  : 'text-dim hover:bg-deep hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            className={`${actionBtn} text-wine-ink`}
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? '收起' : '+ 新增组合'}
          </button>
          <Leader />
          <a
            href="/api/admin/pricing/export"
            className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink"
          >
            导出 XLSX
          </a>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleImport(f)
            }}
          />
          <button
            type="button"
            className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink disabled:opacity-40"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            {importing ? '导入中…' : '导入 XLSX'}
          </button>
        </div>
      </div>

      {/* Import result */}
      {importResult && (
        <div className="mt-3 border border-line bg-card px-4 py-3 text-[12.5px]">
          <div className="flex items-center justify-between">
            <span className="text-ink">
              已更新 <strong>{importResult.updated}</strong> 条
              {importResult.skipped.length > 0 && (
                <span className="ml-2 text-wine-ink">跳过 {importResult.skipped.length} 条</span>
              )}
            </span>
            <button type="button" className="text-dim hover:text-ink" onClick={() => setImportResult(null)}>✕</button>
          </div>
          {importResult.skipped.length > 0 && (
            <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-dim">
              {importResult.skipped.slice(0, 10).map((s, i) => (
                <li key={i}>行 {s.row}: {s.reason}</li>
              ))}
              {importResult.skipped.length > 10 && (
                <li>… 及其余 {importResult.skipped.length - 10} 条</li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* Add combo form */}
      {showAdd && (
        <div className="pt-4">
          <AddComboForm modes={modes} papers={papers} onChanged={onChanged} />
        </div>
      )}

      {/* Matrix table */}
      <div className="mt-4 overflow-x-auto border border-ink">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-ink bg-card">
              <th className="sticky left-0 z-10 min-w-[220px] bg-card px-4 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">
                模式 × 纸张
              </th>
              {sizes.map((s) => (
                <th
                  key={s.key}
                  className="min-w-[72px] px-2 py-2.5 text-center font-mono text-[10.5px] tracking-[.14em] text-dim"
                >
                  {s.label}
                </th>
              ))}
              <th className="w-12 px-2 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {paged.map((row) => {
              const combo = comboBy.get(row.key)
              return (
                <tr key={row.key} className="border-b border-line last:border-b-0 hover:bg-deep/30">
                  <td className="sticky left-0 z-10 bg-paper px-4 py-[9px]">
                    <span className="text-[13px] font-medium text-ink">
                      {modeName.get(row.mode_id)}
                    </span>
                    <span className="text-dim"> × </span>
                    <span className="text-[13px] text-ink">{paperName.get(row.paper_id)}</span>
                  </td>
                  {sizes.map((s) => {
                    const q = row.cells.get(s.key)
                    if (!q) {
                      return (
                        <td key={s.key} className="px-2 py-[9px] text-center">
                          <span className="text-dim/40">—</span>
                        </td>
                      )
                    }
                    const f = FLAG_STYLE[q.flag]
                    const cellKey = `${row.mode_id}:${row.paper_id}:${s.key}`
                    const isEditing = editing === cellKey
                    return (
                      <td
                        key={s.key}
                        className={`cursor-pointer px-2 py-[9px] text-center transition-colors ${FLAG_BG[q.flag] ?? ''} ${isEditing ? 'ring-2 ring-wine ring-inset' : 'hover:bg-deep/40'}`}
                        onClick={() => combo && setEditing(isEditing ? null : cellKey)}
                        title={`墨耗 ${q.ink_display} + 纸张 ${q.paper_display} = 成本 ${q.total_display}\n地板价 ${q.auto_display} · 售价 ${q.sell_display} (${q.source})`}
                      >
                        <span className={`font-mono text-[12.5px] ${f.cls === 'text-dim' ? 'text-ink' : f.cls}`}>
                          {q.sell_display}
                        </span>
                        {(q.flag === 'below_margin' || q.flag === 'LOSS') && (
                          <span className={`ml-0.5 text-[9px] ${f.cls}`}>
                            {q.flag === 'LOSS' ? '!' : '~'}
                          </span>
                        )}
                      </td>
                    )
                  })}
                  <td className="px-2 py-[9px] text-center">
                    {combo && (
                      <button
                        type="button"
                        className={`${actionBtn} text-dim`}
                        onClick={() => void archiveCombo(combo)}
                      >
                        归档
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {paged.length === 0 && (
              <tr>
                <td colSpan={sizes.length + 2} className="px-4 py-8 text-center text-[13px] text-dim">
                  {search || flagFilter !== 'all' ? '无匹配结果' : '暂无报价组合'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Edit panel below table */}
      {editingQuote && (
        <div className="mt-4">
          <PriceEditPanel
            combo={editingQuote.combo}
            quote={editingQuote.quote}
            onDone={() => {
              setEditing(null)
              onChanged()
            }}
          />
        </div>
      )}

      <Paginator page={page} totalPages={totalPages} onPage={setPage} />

      <div className="pt-3 text-right font-mono text-[10px] tracking-[.1em] text-dim">
        {filtered.length} 组合 · {quotes.length} 可报价项
      </div>
    </div>
  )
}
