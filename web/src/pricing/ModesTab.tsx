import { useMemo, useState, type FormEvent } from 'react'
import { send } from '../api'
import { Field, Modal, PillBtn, specInput, toast } from '../spec'
import { actionBtn, type ModeDto, type PrinterDto, type SizeDto } from './types'

function ModeEditModal({
  mode,
  sizes,
  onClose,
  onDone,
}: {
  mode: ModeDto
  sizes: SizeDto[]
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState(mode.name)
  const [inkPrice, setInkPrice] = useState(String(mode.ink_price_c))
  const [mlPerBatch, setMlPerBatch] = useState(mode.ml_per_batch == null ? '' : String(mode.ml_per_batch))
  const [yieldSheets, setYieldSheets] = useState(String(mode.yield_sheets))
  const [refSize, setRefSize] = useState(mode.ref_size)
  const [maxSize, setMaxSize] = useState(mode.max_size)
  const [colorClass, setColorClass] = useState(mode.color_class ?? '')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const price = Math.trunc(Number(inkPrice))
    const ys = Math.trunc(Number(yieldSheets))
    if (name.trim() === '' || price < 0 || ys < 1) {
      setError('名称非空、墨价非负整数（_c）、产能正整数')
      return
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      ink_price_c: price,
      yield_sheets: ys,
      ref_size: refSize,
      max_size: maxSize,
      color_class: colorClass.trim() === '' ? null : colorClass.trim(),
    }
    if (mode.pricing_mode === 'ml' && mlPerBatch.trim() !== '') {
      body.ml_per_batch = Math.trunc(Number(mlPerBatch))
    }
    const res = await send('PATCH', `/api/pricing/modes/${mode.id}`, body)
    if (res.ok) { toast('模式已保存', 'ok'); onDone() }
    else setError('保存失败')
  }

  return (
    <Modal open title={`编辑模式 · ${mode.name}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
        <Field label="名称">
          <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={mode.pricing_mode === 'ml' ? '墨价 _c/ml' : '墨价 _c/套'}>
          <input type="number" min={0} required className={specInput} value={inkPrice} onChange={(e) => setInkPrice(e.target.value)} />
        </Field>
        {mode.pricing_mode === 'ml' && (
          <Field label="每批 ml">
            <input type="number" min={1} className={specInput} value={mlPerBatch} onChange={(e) => setMlPerBatch(e.target.value)} />
          </Field>
        )}
        <Field label={`产能（${refSize} 张/批）`}>
          <input type="number" min={1} required className={specInput} value={yieldSheets} onChange={(e) => setYieldSheets(e.target.value)} />
        </Field>
        <Field label="基准尺寸">
          <select className={specInput} value={refSize} onChange={(e) => setRefSize(e.target.value)}>
            {sizes.map((s) => (
              <option key={s.key} value={s.key}>{s.key}</option>
            ))}
          </select>
        </Field>
        <Field label="最大尺寸">
          <select className={specInput} value={maxSize} onChange={(e) => setMaxSize(e.target.value)}>
            {sizes.map((s) => (
              <option key={s.key} value={s.key}>{s.key}</option>
            ))}
          </select>
        </Field>
        <Field label="色彩档（bw/color/photo…）">
          <input type="text" className={specInput} value={colorClass} onChange={(e) => setColorClass(e.target.value)} />
        </Field>
        <div className="flex items-end pb-1">
          <PillBtn>保存</PillBtn>
        </div>
        {error && <p className="col-span-2 text-[12px] text-wine-ink">{error}</p>}
      </form>
    </Modal>
  )
}

export default function ModesTab({
  modes,
  sizes,
  printers,
  onChanged,
}: {
  modes: ModeDto[]
  sizes: SizeDto[]
  printers: PrinterDto[]
  onChanged: () => void
}) {
  const [search, setSearch] = useState('')
  const [printerFilter, setPrinterFilter] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '',
    printer_id: '',
    ink_type: 'toner',
    pricing_mode: 'set',
    ink_price_c: '',
    ml_per_batch: '',
    yield_sheets: '',
    ref_size: '',
    max_size: '',
    duplex: false,
    color_class: '',
  })

  const printerCode = useMemo(() => new Map(printers.map((p) => [p.id, p.code])), [printers])

  const active = useMemo(() => modes.filter((m) => m.archived === 0), [modes])

  const filtered = useMemo(() => {
    let result = active
    if (search.trim()) {
      const s = search.toLowerCase()
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(s) ||
          (printerCode.get(m.printer_id) ?? '').toLowerCase().includes(s),
      )
    }
    if (printerFilter) {
      result = result.filter((m) => m.printer_id === Number(printerFilter))
    }
    return result
  }, [active, search, printerFilter, printerCode])

  const grouped = useMemo(() => {
    const map = new Map<number, ModeDto[]>()
    for (const m of filtered) {
      const g = map.get(m.printer_id)
      if (g) g.push(m)
      else map.set(m.printer_id, [m])
    }
    return [...map.entries()]
  }, [filtered])

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const addMode = async (e: FormEvent) => {
    e.preventDefault()
    const body = {
      name: form.name.trim(),
      printer_id: Number(form.printer_id),
      ink_type: form.ink_type,
      pricing_mode: form.pricing_mode,
      ink_price_c: Math.trunc(Number(form.ink_price_c)),
      ml_per_batch: form.pricing_mode === 'ml' ? Math.trunc(Number(form.ml_per_batch)) : null,
      yield_sheets: Math.trunc(Number(form.yield_sheets)),
      ref_size: form.ref_size,
      max_size: form.max_size,
      duplex: form.duplex,
      color_class: form.color_class.trim() === '' ? null : form.color_class.trim(),
    }
    if (body.name === '' || !body.printer_id || body.ref_size === '' || body.max_size === '') return
    const res = await send('POST', '/api/pricing/modes', body)
    if (res.ok) {
      setAdding(false)
      setNotice('模式已建——配组合后才可报价')
      toast('模式已创建', 'ok')
      onChanged()
    } else setNotice(res.status === 422 ? 'ml 计价必须填每批毫升数' : '创建失败，检查输入')
  }

  const editingMode = editing != null ? active.find((m) => m.id === editing) ?? null : null

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-4 pt-5">
        <input
          type="text"
          placeholder="搜索模式…"
          className="w-48 border border-line bg-card px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-dim/60 focus:border-wine"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="border border-line bg-card px-3 py-1.5 text-[13px] text-ink outline-none focus:border-wine"
          value={printerFilter}
          onChange={(e) => setPrinterFilter(e.target.value)}
        >
          <option value="">全部打印机</option>
          {printers.map((p) => (
            <option key={p.id} value={p.id}>{p.code}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            className={`${actionBtn} text-wine-ink`}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? '收起' : '+ 新增模式'}
          </button>
          {notice && <span className="text-[12px] text-wine-ink">{notice}</span>}
        </div>
      </div>

      {/* Add mode form */}
      {adding && (
        <form onSubmit={(e) => void addMode(e)} className="mt-4 grid grid-cols-2 items-end gap-3 border border-ink bg-card p-4 md:grid-cols-4">
          <span className="col-span-full font-mono text-[10px] tracking-[.14em] text-dim">NEW MODE</span>
          <Field label="名称">
            <input type="text" required className={specInput} value={form.name} onChange={set('name')} />
          </Field>
          <Field label="打印机">
            <select className={specInput} value={form.printer_id} onChange={set('printer_id')}>
              <option value="">— 选择 —</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>{p.code}</option>
              ))}
            </select>
          </Field>
          <Field label="墨种">
            <select className={specInput} value={form.ink_type} onChange={set('ink_type')}>
              <option value="toner">toner</option>
              <option value="pigment">pigment</option>
              <option value="dye">dye</option>
            </select>
          </Field>
          <Field label="计价">
            <select className={specInput} value={form.pricing_mode} onChange={set('pricing_mode')}>
              <option value="set">set（按套）</option>
              <option value="ml">ml（按毫升）</option>
            </select>
          </Field>
          <Field label={form.pricing_mode === 'ml' ? '墨价 _c/ml' : '墨价 _c/套'}>
            <input type="number" min={0} required className={specInput} value={form.ink_price_c} onChange={set('ink_price_c')} />
          </Field>
          {form.pricing_mode === 'ml' && (
            <Field label="每批 ml">
              <input type="number" min={1} required className={specInput} value={form.ml_per_batch} onChange={set('ml_per_batch')} />
            </Field>
          )}
          <Field label="产能（张/批）">
            <input type="number" min={1} required className={specInput} value={form.yield_sheets} onChange={set('yield_sheets')} />
          </Field>
          <Field label="色彩档（bw/color/photo…）">
            <input type="text" className={specInput} value={form.color_class} onChange={set('color_class')} />
          </Field>
          <Field label="基准尺寸">
            <select className={specInput} value={form.ref_size} onChange={set('ref_size')}>
              <option value="">—</option>
              {sizes.map((s) => (
                <option key={s.key} value={s.key}>{s.key}</option>
              ))}
            </select>
          </Field>
          <Field label="最大尺寸">
            <select className={specInput} value={form.max_size} onChange={set('max_size')}>
              <option value="">—</option>
              {sizes.map((s) => (
                <option key={s.key} value={s.key}>{s.key}</option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 pb-3 text-[12px] text-dim">
            <input
              type="checkbox"
              checked={form.duplex}
              onChange={(e) => setForm((f) => ({ ...f, duplex: e.target.checked }))}
            />
            双面（产能已含减半）
          </label>
          <PillBtn>创建模式</PillBtn>
        </form>
      )}

      {/* Grouped list */}
      <div className="mt-4">
        {grouped.map(([printerId, groupModes]) => (
          <div key={printerId} className="mb-6">
            <div className="mb-2 flex items-baseline gap-2 border-b border-ink pb-1.5">
              <span className="bg-ink px-2 py-0.5 font-mono text-[10px] tracking-[.18em] text-paper">
                {printerCode.get(printerId) ?? printerId}
              </span>
              <span className="font-mono text-[10px] tracking-[.1em] text-dim">
                {groupModes.length} 模式
              </span>
            </div>

            <div className="overflow-x-auto border border-line">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-card">
                    <th className="px-4 py-2 text-left font-mono text-[10px] tracking-[.12em] text-dim">模式名</th>
                    <th className="px-3 py-2 text-left font-mono text-[10px] tracking-[.12em] text-dim">墨种/计价</th>
                    <th className="px-3 py-2 text-right font-mono text-[10px] tracking-[.12em] text-dim">墨价 _c</th>
                    <th className="px-3 py-2 text-right font-mono text-[10px] tracking-[.12em] text-dim">产能</th>
                    <th className="px-3 py-2 text-center font-mono text-[10px] tracking-[.12em] text-dim">尺寸范围</th>
                    <th className="px-3 py-2 text-center font-mono text-[10px] tracking-[.12em] text-dim">色彩</th>
                    <th className="w-24 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {groupModes.map((m) => (
                    <tr key={m.id} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-[8px]">
                        <span className="font-medium text-ink">{m.name}</span>
                        {m.duplex !== 0 && <span className="ml-1.5 font-mono text-[10px] tracking-[.1em] text-dim">双</span>}
                      </td>
                      <td className="px-3 py-[8px] text-[12px] text-dim">
                        {m.ink_type}/{m.pricing_mode}
                      </td>
                      <td className="px-3 py-[8px] text-right font-mono text-[12px] text-ink">
                        {m.ink_price_c.toLocaleString()}
                        <span className="text-dim">
                          {m.pricing_mode === 'ml' ? `/ml` : `/套`}
                        </span>
                      </td>
                      <td className="px-3 py-[8px] text-right font-mono text-[12px] text-ink">
                        {m.yield_sheets.toLocaleString()}
                      </td>
                      <td className="px-3 py-[8px] text-center text-[12px] text-dim">
                        {m.ref_size} → {m.max_size}
                      </td>
                      <td className="px-3 py-[8px] text-center text-[12px] text-dim">
                        {m.color_class ?? '—'}
                      </td>
                      <td className="px-3 py-[8px]">
                        <div className="flex justify-end gap-3">
                          <button
                            type="button"
                            className={`${actionBtn} text-wine-ink`}
                            onClick={() => setEditing(m.id)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className={`${actionBtn} text-dim`}
                            onClick={() => {
                              if (window.confirm(`归档模式「${m.name}」？`)) {
                                void send('DELETE', `/api/pricing/modes/${m.id}`).then((r) => r.ok && onChanged())
                              }
                            }}
                          >
                            归档
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {grouped.length === 0 && (
          <p className="py-8 text-center text-[13px] text-dim">
            {search || printerFilter ? '无匹配结果' : '暂无打印模式'}
          </p>
        )}
      </div>

      {editingMode && (
        <ModeEditModal
          mode={editingMode}
          sizes={sizes}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); onChanged() }}
        />
      )}

      <div className="pt-3 text-right font-mono text-[10px] tracking-[.1em] text-dim">
        {active.length} 种模式
      </div>
    </div>
  )
}
