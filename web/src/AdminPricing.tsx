import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Field, Leader, MagSec, PillBtn, specInput } from './spec'

interface QuoteDto {
  mode_id: number
  paper_id: number
  size_key: string
  total_c: number
  auto_sell_c: number
  sell_c: number
  source: string
  flag: 'auto' | 'manual' | 'below_margin' | 'LOSS' | 'forced'
  total_display: string
  auto_display: string
  sell_display: string
}

interface ComboDto {
  id: number
  mode_id: number
  paper_id: number
  archived: number
  prices: Array<{ combo_id: number; size_key: string; sell_c: number | null; internal_sell_c: number | null }>
}

interface ModeDto {
  id: number
  name: string
  printer_id: number
  ink_type: string
  pricing_mode: string
  ink_price_c: number
  ml_per_batch: number | null
  yield_sheets: number
  ref_size: string
  max_size: string
  duplex: number
  archived: number
}

interface PaperDto {
  id: number
  name: string
  category: string | null
  gsm: number | null
  supplier: string | null
  archived: number
  size_costs: Array<{ paper_id: number; size_key: string; pack_price_c: number; pack_count: number }>
}

interface SizeDto {
  key: string
  label: string
  area: number
  sort: number
}

interface PrinterDto {
  id: number
  code: string
}

const FLAG_STYLE: Record<QuoteDto['flag'], { label: string; cls: string }> = {
  auto: { label: 'AUTO', cls: 'text-dim' },
  manual: { label: '手动', cls: 'text-ink' },
  below_margin: { label: '低毛利', cls: 'text-warn' },
  LOSS: { label: '亏本', cls: 'text-wine-ink' },
  forced: { label: 'FORCED', cls: 'text-dim' },
}

const actionBtn = 'font-mono text-[10px] tracking-[.14em] hover:opacity-70'

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
    <form onSubmit={(e) => void submit(e)} className="mt-2 flex flex-wrap items-end gap-3 border border-line bg-card p-3.5">
      <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">
        {quote.size_key} · 成本 {quote.total_display} · 地板 {quote.auto_display}
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

function QuotesSection({
  quotes,
  combos,
  modes,
  papers,
  onChanged,
}: {
  quotes: QuoteDto[]
  combos: ComboDto[]
  modes: ModeDto[]
  papers: PaperDto[]
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [newMode, setNewMode] = useState('')
  const [newPaper, setNewPaper] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const modeName = useMemo(() => new Map(modes.map((m) => [m.id, m.name])), [modes])
  const paperName = useMemo(() => new Map(papers.map((p) => [p.id, p.name])), [papers])
  const comboBy = useMemo(
    () => new Map(combos.map((c) => [`${c.mode_id}:${c.paper_id}`, c])),
    [combos],
  )

  const groups = useMemo(() => {
    const m = new Map<string, QuoteDto[]>()
    for (const q of quotes) {
      const key = `${q.mode_id}:${q.paper_id}`
      const g = m.get(key)
      if (g) g.push(q)
      else m.set(key, [q])
    }
    return [...m.entries()]
  }, [quotes])

  const addCombo = async (e: FormEvent) => {
    e.preventDefault()
    if (newMode === '' || newPaper === '') return
    const res = await send('POST', '/api/pricing/combos', {
      mode_id: Number(newMode),
      paper_id: Number(newPaper),
    })
    if (res.ok) {
      setNotice('组合已建——有纸张口径的尺寸即时可报价')
      onChanged()
    } else {
      setNotice(res.status === 409 ? '该组合已存在' : '创建失败')
    }
  }

  const archiveCombo = async (combo: ComboDto) => {
    if (!window.confirm('归档该组合？其全部尺寸将从报价中下架。')) return
    const res = await send('PATCH', `/api/pricing/combos/${combo.id}`, { archived: true })
    if (res.ok) onChanged()
  }

  return (
    <MagSec tag="01" title="报价总览" note={`${quotes.length} QUOTABLE · 橙=低毛利 红=亏本`}>
      <form onSubmit={(e) => void addCombo(e)} className="mb-6 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
        <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW COMBO</span>
        <Field label="打印模式">
          <select className={specInput} value={newMode} onChange={(e) => setNewMode(e.target.value)}>
            <option value="">— 选择 —</option>
            {modes.filter((m) => m.archived === 0).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Field>
        <Field label="纸张">
          <select className={specInput} value={newPaper} onChange={(e) => setNewPaper(e.target.value)}>
            <option value="">— 选择 —</option>
            {papers.filter((p) => p.archived === 0).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <PillBtn>新增组合</PillBtn>
        {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
      </form>

      {groups.map(([key, qs]) => {
        const combo = comboBy.get(key)
        const first = qs[0]
        if (!first) return null
        return (
          <div key={key} className="mb-5">
            <div className="flex items-baseline gap-3 border-b border-ink pb-1.5">
              <span className="text-[14px] font-medium text-ink">
                {modeName.get(first.mode_id)} × {paperName.get(first.paper_id)}
              </span>
              <Leader />
              {combo && (
                <button type="button" className={`${actionBtn} text-dim`} onClick={() => void archiveCombo(combo)}>
                  归档
                </button>
              )}
            </div>
            {qs.map((q) => {
              const id = `${key}:${q.size_key}`
              const f = FLAG_STYLE[q.flag]
              return (
                <div key={id} className="border-b border-line py-[7px]">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="min-w-10 text-[13px] font-medium text-ink">{q.size_key}</span>
                    <span className="font-mono text-[11px] text-dim">成本 {q.total_display}</span>
                    <Leader />
                    <span className={`font-mono text-[10px] tracking-[.1em] ${f.cls}`}>{f.label}</span>
                    <span className={`font-mono text-[13px] ${f.cls === 'text-dim' ? 'text-ink' : f.cls}`}>
                      {q.sell_display}
                    </span>
                    {combo && (
                      <button
                        type="button"
                        className={`${actionBtn} text-wine-ink`}
                        onClick={() => setEditing(editing === id ? null : id)}
                      >
                        定价
                      </button>
                    )}
                  </div>
                  {editing === id && combo && (
                    <PriceEditPanel combo={combo} quote={q} onDone={() => { setEditing(null); onChanged() }} />
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </MagSec>
  )
}

function PapersSection({ papers, sizes, onChanged }: { papers: PaperDto[]; sizes: SizeDto[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [gsm, setGsm] = useState('')
  const [category, setCategory] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const addPaper = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === '') return
    const res = await send('POST', '/api/pricing/papers', {
      name: name.trim(),
      gsm: gsm.trim() === '' ? null : Math.trunc(Number(gsm)),
      category: category.trim() === '' ? null : category.trim(),
    })
    if (res.ok) {
      setName('')
      setGsm('')
      setCategory('')
      setNotice('纸张已建——补好尺寸口径才可参与报价')
      onChanged()
    } else setNotice('创建失败')
  }

  return (
    <MagSec tag="02" title="纸张与口径" note="PAPER · PACK COST">
      <form onSubmit={(e) => void addPaper(e)} className="mb-6 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
        <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW PAPER</span>
        <Field label="名称">
          <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="克重 gsm（可空）">
          <input type="number" min={1} className={specInput} value={gsm} onChange={(e) => setGsm(e.target.value)} />
        </Field>
        <Field label="类别（可空）">
          <input type="text" className={specInput} value={category} onChange={(e) => setCategory(e.target.value)} />
        </Field>
        <PillBtn>新增纸张</PillBtn>
        {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
      </form>

      {papers.filter((p) => p.archived === 0).map((p) => (
        <div key={p.id} className="border-b border-line py-[8px]">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-[14px] font-medium text-ink">{p.name}</span>
            {p.gsm != null && <span className="text-[11.5px] text-dim">{p.gsm}g</span>}
            {p.category && <span className="text-[11.5px] text-dim">{p.category}</span>}
            <Leader />
            <span className="font-mono text-[11px] text-dim">
              {p.size_costs.map((c) => c.size_key).join(' · ') || '无口径'}
            </span>
            <button
              type="button"
              className={`${actionBtn} text-wine-ink`}
              onClick={() => setEditing(editing === p.id ? null : p.id)}
            >
              口径
            </button>
            <button
              type="button"
              className={`${actionBtn} text-dim`}
              onClick={() => {
                if (window.confirm(`归档纸张「${p.name}」？`)) {
                  void send('DELETE', `/api/pricing/papers/${p.id}`).then((r) => r.ok && onChanged())
                }
              }}
            >
              归档
            </button>
          </div>
          {editing === p.id && <PackCostEditor paper={p} sizes={sizes} onChanged={onChanged} />}
        </div>
      ))}
    </MagSec>
  )
}

function PackCostEditor({ paper, sizes, onChanged }: { paper: PaperDto; sizes: SizeDto[]; onChanged: () => void }) {
  const [sizeKey, setSizeKey] = useState('')
  const [packPrice, setPackPrice] = useState('')
  const [packCount, setPackCount] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const price = Math.trunc(Number(packPrice))
    const count = Math.trunc(Number(packCount))
    if (sizeKey === '' || price < 0 || count < 1) {
      setError('选择尺寸并填写非负整数包价（_c）与正整数包内张数')
      return
    }
    const res = await send('PUT', '/api/pricing/paper-size-costs', {
      paper_id: paper.id,
      size_key: sizeKey,
      pack_price_c: price,
      pack_count: count,
    })
    if (res.ok) onChanged()
    else setError('保存失败')
  }

  return (
    <div className="mt-2 border border-line bg-card p-3.5">
      {paper.size_costs.length > 0 && (
        <div className="mb-3">
          {paper.size_costs.map((c) => (
            <div key={c.size_key} className="flex items-baseline gap-3 border-b border-line py-[6px]">
              <span className="min-w-10 text-[12.5px] font-medium text-ink">{c.size_key}</span>
              <span className="font-mono text-[11.5px] text-dim">
                {c.pack_price_c}_c / {c.pack_count} 张
              </span>
              <Leader />
              <button
                type="button"
                className={`${actionBtn} text-dim`}
                onClick={() => {
                  void send('DELETE', `/api/pricing/paper-size-costs/${paper.id}/${c.size_key}`).then(
                    (r) => r.ok && onChanged(),
                  )
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3">
        <Field label="尺寸">
          <select className={specInput} value={sizeKey} onChange={(e) => setSizeKey(e.target.value)}>
            <option value="">— 选择 —</option>
            {sizes.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="整包价 _c">
          <input type="number" min={0} required className={specInput} value={packPrice} onChange={(e) => setPackPrice(e.target.value)} />
        </Field>
        <Field label="包内张数">
          <input type="number" min={1} required className={specInput} value={packCount} onChange={(e) => setPackCount(e.target.value)} />
        </Field>
        <PillBtn>写入口径</PillBtn>
        {error && <p className="w-full text-[12px] text-wine-ink">{error}</p>}
      </form>
    </div>
  )
}

function ModeEditPanel({ mode, onDone }: { mode: ModeDto; onDone: () => void }) {
  const [name, setName] = useState(mode.name)
  const [inkPrice, setInkPrice] = useState(String(mode.ink_price_c))
  const [yieldSheets, setYieldSheets] = useState(String(mode.yield_sheets))
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const price = Math.trunc(Number(inkPrice))
    const ys = Math.trunc(Number(yieldSheets))
    if (name.trim() === '' || price < 0 || ys < 1) {
      setError('名称非空、墨价非负整数（_c）、产能正整数')
      return
    }
    const res = await send('PATCH', `/api/pricing/modes/${mode.id}`, {
      name: name.trim(),
      ink_price_c: price,
      yield_sheets: ys,
    })
    if (res.ok) onDone()
    else setError('保存失败')
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-2 flex flex-wrap items-end gap-3 border border-line bg-card p-3.5">
      <Field label="名称">
        <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={mode.pricing_mode === 'ml' ? '墨价 _c/ml' : '墨价 _c/套'}>
        <input type="number" min={0} required className={specInput} value={inkPrice} onChange={(e) => setInkPrice(e.target.value)} />
      </Field>
      <Field label={`产能（${mode.ref_size} 张/批）`}>
        <input type="number" min={1} required className={specInput} value={yieldSheets} onChange={(e) => setYieldSheets(e.target.value)} />
      </Field>
      <PillBtn>保存</PillBtn>
      {error && <p className="w-full text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

function ModesSection({
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
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
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
  })
  const [notice, setNotice] = useState<string | null>(null)
  const printerCode = useMemo(() => new Map(printers.map((p) => [p.id, p.code])), [printers])

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
    }
    if (body.name === '' || !body.printer_id || body.ref_size === '' || body.max_size === '') return
    const res = await send('POST', '/api/pricing/modes', body)
    if (res.ok) {
      setAdding(false)
      setNotice('模式已建——配组合后才可报价')
      onChanged()
    } else setNotice(res.status === 422 ? 'ml 计价必须填每批毫升数' : '创建失败，检查输入')
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <MagSec tag="03" title="打印模式" note="MODES">
      <div className="mb-4">
        <button type="button" className={`${actionBtn} text-wine-ink`} onClick={() => setAdding((v) => !v)}>
          {adding ? '收起' : '+ 新增模式'}
        </button>
        {notice && <span className="ml-4 text-[12px] text-wine-ink">{notice}</span>}
      </div>
      {adding && (
        <form onSubmit={(e) => void addMode(e)} className="mb-6 grid grid-cols-2 items-end gap-3 border border-ink bg-card p-4 md:grid-cols-4">
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

      {modes.filter((m) => m.archived === 0).map((m) => (
        <div key={m.id} className="border-b border-line py-[8px]">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="min-w-14 font-mono text-[11px] tracking-[.08em] text-dim">
              {printerCode.get(m.printer_id) ?? m.printer_id}
            </span>
            <span className="text-[14px] font-medium text-ink">{m.name}</span>
            <span className="text-[11.5px] text-dim">
              {m.pricing_mode === 'ml' ? `${m.ink_price_c}_c/ml × ${m.ml_per_batch}ml` : `${m.ink_price_c}_c/套`}
              · {m.yield_sheets} 张/批 · ≤{m.max_size}
            </span>
            {m.duplex !== 0 && <span className="font-mono text-[9.5px] tracking-[.1em] text-dim">双</span>}
            <Leader />
            <button
              type="button"
              className={`${actionBtn} text-wine-ink`}
              onClick={() => setEditing(editing === m.id ? null : m.id)}
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
          {editing === m.id && <ModeEditPanel mode={m} onDone={() => { setEditing(null); onChanged() }} />}
        </div>
      ))}
    </MagSec>
  )
}

function SizesSection({ sizes, onChanged }: { sizes: SizeDto[]; onChanged: () => void }) {
  const [form, setForm] = useState({ key: '', label: '', area: '', sort: '' })
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const area = Number(form.area)
    if (form.key.trim() === '' || form.label.trim() === '' || !(area > 0)) {
      setNotice('key / 标签非空，相对面积为正数')
      return
    }
    const res = await send('POST', '/api/pricing/sizes', {
      key: form.key.trim(),
      label: form.label.trim(),
      area,
      sort: form.sort.trim() === '' ? 0 : Math.trunc(Number(form.sort)),
    })
    if (res.ok) {
      setForm({ key: '', label: '', area: '', sort: '' })
      setNotice(null)
      onChanged()
    } else setNotice(res.status === 409 ? '该 key 已存在' : '创建失败')
  }

  return (
    <MagSec tag="04" title="尺寸" note="RELATIVE AREA">
      {sizes.map((s) => (
        <div key={s.key} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-[7px]">
          <span className="min-w-12 text-[13px] font-medium text-ink">{s.key}</span>
          <span className="text-[12px] text-dim">{s.label}</span>
          <Leader />
          <span className="font-mono text-[11px] text-dim">area {s.area} · sort {s.sort}</span>
          <button
            type="button"
            className={`${actionBtn} text-dim`}
            onClick={() => {
              if (!window.confirm(`删除尺寸 ${s.key}？被引用时会被拒绝。`)) return
              void send('DELETE', `/api/pricing/sizes/${s.key}`).then((r) => {
                if (r.ok) onChanged()
                else setNotice(r.status === 409 ? `${s.key} 被引用，禁止删除` : '删除失败')
              })
            }}
          >
            删除
          </button>
        </div>
      ))}
      <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
        <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW SIZE</span>
        <Field label="key">
          <input type="text" required className={specInput} value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
        </Field>
        <Field label="标签">
          <input type="text" required className={specInput} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
        </Field>
        <Field label="相对面积">
          <input type="number" step="any" min={0} required className={specInput} value={form.area} onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))} />
        </Field>
        <Field label="排序">
          <input type="number" className={specInput} value={form.sort} onChange={(e) => setForm((f) => ({ ...f, sort: e.target.value }))} />
        </Field>
        <PillBtn>新增尺寸</PillBtn>
        {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
      </form>
    </MagSec>
  )
}

function PricingBody() {
  const [quotes, setQuotes] = useState<QuoteDto[] | null>(null)
  const [combos, setCombos] = useState<ComboDto[] | null>(null)
  const [modes, setModes] = useState<ModeDto[] | null>(null)
  const [papers, setPapers] = useState<PaperDto[] | null>(null)
  const [sizes, setSizes] = useState<SizeDto[] | null>(null)
  const [printers, setPrinters] = useState<PrinterDto[] | null>(null)

  const reload = useCallback(() => {
    void send<QuoteDto[]>('GET', '/api/admin/pricing/quotes').then((r) => r.ok && setQuotes(r.data))
    void send<ComboDto[]>('GET', '/api/pricing/combos').then((r) => r.ok && setCombos(r.data))
    void send<ModeDto[]>('GET', '/api/pricing/modes').then((r) => r.ok && setModes(r.data))
    void send<PaperDto[]>('GET', '/api/pricing/papers').then((r) => r.ok && setPapers(r.data))
    void send<SizeDto[]>('GET', '/api/pricing/sizes').then((r) => r.ok && setSizes(r.data))
    void send<PrinterDto[]>('GET', '/api/equipment').then((r) => r.ok && setPrinters(r.data))
  }, [])
  useEffect(reload, [reload])

  if (!quotes || !combos || !modes || !papers || !sizes || !printers) {
    return <p className="pt-13 text-[14px] text-dim">价目加载中…</p>
  }

  return (
    <div>
      <QuotesSection quotes={quotes} combos={combos} modes={modes} papers={papers} onChanged={reload} />
      <PapersSection papers={papers} sizes={sizes} onChanged={reload} />
      <ModesSection modes={modes} sizes={sizes} printers={printers} onChanged={reload} />
      <SizesSection sizes={sizes} onChanged={reload} />
    </div>
  )
}

export default function AdminPricing() {
  return <AdminGate>{() => <PricingBody />}</AdminGate>
}
