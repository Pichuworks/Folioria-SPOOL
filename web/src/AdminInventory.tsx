import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Field, Leader, MagSec, Paginator, PillBtn, Skeleton, TabBar, specInput, toast, usePagination } from './spec'

interface StockDto {
  id: string
  paper_id: number
  size_key: string
  quantity: number
  location_id: string | null
  opened: number
  notes: string | null
  paper_name: string
  size_label: string
  moisture_status: string
}

interface ConsumableDto {
  id: string
  name: string
  type: string
  printer_id: number
  quantity: number
  unit_cost_c: number
  unit_cost_display: string
  supplier: string | null
  alert_threshold_bp: number
  printer_code: string
  printer_name: string
  archived: number
}

interface LogDto {
  id: string
  target_type: string
  target_id: string
  action: string
  quantity_delta: number
  convert_group: string | null
  reason: string | null
  created_at: string
}

interface RefDto {
  papers: Array<{ id: number; name: string }>
  sizes: Array<{ key: string; label: string }>
  printers: Array<{ id: number; code: string; name: string }>
}

const ACTION_LABEL: Record<string, string> = {
  purchase: '采购入库',
  consume: '消耗出库',
  adjust: '盘点调整',
  scrap: '报废',
  return: '退回入库',
  convert: '裁切转换',
}

const CONSUMABLE_TYPE_LABEL: Record<string, string> = {
  toner: '碳粉',
  ink: '墨水',
  printhead: '打印头',
  fuser: '定影器',
  drum: '硒鼓',
  other: '其他',
}

const CURRENCIES = ['JPY', 'CNY', 'USD'] as const

const TABS = [
  { key: 'stocks', label: '纸张库存' },
  { key: 'consumables', label: '耗材' },
  { key: 'timeline', label: '出入库时间线' },
] as const

type TabKey = (typeof TABS)[number]['key']

/* ─── Purchase fields (shared by MovementPanel & NewStockForm) ─── */

function PurchaseFields({
  currency, setCurrency, amount, setAmount, costC, setCostC, note, setNote,
}: {
  currency: string; setCurrency: (v: string) => void
  amount: string; setAmount: (v: string) => void
  costC: string; setCostC: (v: string) => void
  note: string; setNote: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="原币种">
        <select className={specInput} value={currency} onChange={(e) => setCurrency(e.target.value)}>
          <option value="">— 选择 —</option>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="原币金额（最小单位整数）">
        <input type="number" min={0} className={specInput} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="换算单价_c（基准货币）">
        <input type="number" min={0} className={specInput} value={costC} onChange={(e) => setCostC(e.target.value)} />
      </Field>
      <Field label="汇率备注">
        <input type="text" className={specInput} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </div>
  )
}

function buildPurchasePayload(currency: string, amount: string, costC: string, note: string) {
  const payload: Record<string, unknown> = {}
  if (currency) payload.original_currency = currency
  const a = Math.trunc(Number(amount))
  if (a > 0) payload.original_amount = a
  const c = Math.trunc(Number(costC))
  if (c > 0) payload.converted_cost_c = c
  if (note.trim()) payload.exchange_rate_note = note.trim()
  return payload
}

/* ─── Timeline ─── */

function TimelineSection({ filteredLog, actionFilter, setActionFilter, targetLabel }: {
  filteredLog: LogDto[]
  actionFilter: string
  setActionFilter: (v: string) => void
  targetLabel: Map<string, string>
}) {
  const { page, totalPages, paged, setPage } = usePagination(filteredLog, 50)

  return (
    <div className="pt-5">
      <div className="mb-3 max-w-56">
        <Field label="按动作筛选">
          <select className={specInput} value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(0) }}>
            <option value="">全部</option>
            {Object.entries(ACTION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </Field>
      </div>
      {filteredLog.length === 0 ? (
        <p className="py-2 text-[13px] text-dim">暂无记录</p>
      ) : (
        <>
          {paged.map((l) => (
            <div key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-[8px]">
              <span className="font-mono text-[10px] tracking-[.08em] text-dim">{l.created_at.slice(0, 16).replace('T', ' ')}</span>
              <span className="min-w-16 text-[13px] font-medium text-ink">{ACTION_LABEL[l.action] ?? l.action}</span>
              <span className="text-[12px] text-dim">{targetLabel.get(l.target_id) ?? l.target_id.slice(0, 8)}</span>
              {l.convert_group && <span className="font-mono text-[9.5px] tracking-[.1em] text-dim">成对 {l.convert_group.slice(0, 8)}</span>}
              {l.reason && <span className="text-[11.5px] text-dim">{l.reason}</span>}
              <Leader />
              <span className={`font-mono text-[13px] ${l.quantity_delta < 0 ? 'text-warn' : 'text-wine-ink'}`}>
                {l.quantity_delta > 0 ? `+${l.quantity_delta}` : l.quantity_delta}
              </span>
            </div>
          ))}
          <Paginator page={page} totalPages={totalPages} onPage={setPage} />
        </>
      )}
      <div className="mt-3 text-right">
        <a href="/api/inventory/log/export" className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink">导出 XLSX ↧</a>
      </div>
    </div>
  )
}

/* ─── Movement panel (with purchase price fields) ─── */

const actionBtn = 'font-mono text-[10px] tracking-[.14em] hover:opacity-70'

function MovementPanel({ stock, onDone }: { stock: StockDto; onDone: () => void }) {
  const [action, setAction] = useState('purchase')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [currency, setCurrency] = useState('')
  const [amount, setAmount] = useState('')
  const [costC, setCostC] = useState('')
  const [rateNote, setRateNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const n = Math.trunc(Number(qty))
    if (!Number.isSafeInteger(n) || n === 0) {
      setError('数量须为非零整数')
      return
    }
    const delta = action === 'adjust' ? n : ['consume', 'scrap'].includes(action) ? -Math.abs(n) : Math.abs(n)
    const payload: Record<string, unknown> = {
      action,
      quantity_delta: delta,
      reason: reason.trim() === '' ? null : reason.trim(),
    }
    if (action === 'purchase') {
      Object.assign(payload, buildPurchasePayload(currency, amount, costC, rateNote))
    }
    const res = await send('POST', `/api/inventory/stocks/${stock.id}/movements`, payload)
    if (res.ok) { toast(`${ACTION_LABEL[action]}已记账`, 'ok'); onDone() }
    else setError(res.status === 409 ? '账面不足，无法出库' : '录入失败，请检查输入')
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-2 space-y-3 border border-line bg-card p-3.5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="动作">
          <select className={specInput} value={action} onChange={(e) => setAction(e.target.value)}>
            {['purchase', 'consume', 'adjust', 'scrap', 'return'].map((a) => (
              <option key={a} value={a}>{ACTION_LABEL[a]}</option>
            ))}
          </select>
        </Field>
        <Field label={action === 'adjust' ? '调整量（±张）' : '数量（张）'}>
          <input type="number" required className={specInput} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="备注">
          <input type="text" className={specInput} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <PillBtn>记账</PillBtn>
      </div>
      {action === 'purchase' && (
        <PurchaseFields
          currency={currency} setCurrency={setCurrency}
          amount={amount} setAmount={setAmount}
          costC={costC} setCostC={setCostC}
          note={rateNote} setNote={setRateNote}
        />
      )}
      {error && <p className="text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

/* ─── Convert panel ─── */

function ConvertPanel({ stock, stocks, onDone }: { stock: StockDto; stocks: StockDto[]; onDone: () => void }) {
  const targets = stocks.filter((s) => s.paper_id === stock.paper_id && s.id !== stock.id)
  const [toId, setToId] = useState('')
  const [fromQty, setFromQty] = useState('')
  const [toQty, setToQty] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const f = Math.trunc(Number(fromQty))
    const t = Math.trunc(Number(toQty))
    if (toId === '' || f < 1 || t < 1) {
      setError('选择目标尺寸并填写两侧正整数数量')
      return
    }
    const res = await send('POST', '/api/inventory/convert', {
      from: { stock_id: stock.id, quantity_delta: -f },
      to: { stock_id: toId, quantity_delta: t },
    })
    if (res.ok) { toast('裁切已记账', 'ok'); onDone() }
    else setError(res.status === 409 ? '账面不足，无法裁切' : '裁切录入失败（仅允许同纸不同尺寸）')
  }

  if (targets.length === 0) {
    return <p className="mt-2 border border-line bg-card p-3.5 text-[12px] text-dim">该纸种没有其他尺寸的库存档案，先在下方新建。</p>
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-2 flex flex-wrap items-end gap-3 border border-line bg-card p-3.5">
      <Field label={`裁出（${stock.size_label} −张）`}>
        <input type="number" min={1} required className={specInput} value={fromQty} onChange={(e) => setFromQty(e.target.value)} />
      </Field>
      <Field label="裁入目标">
        <select className={specInput} value={toId} onChange={(e) => setToId(e.target.value)}>
          <option value="">— 选择 —</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.size_label}</option>
          ))}
        </select>
      </Field>
      <Field label="裁入（+张）">
        <input type="number" min={1} required className={specInput} value={toQty} onChange={(e) => setToQty(e.target.value)} />
      </Field>
      <PillBtn>成对记账</PillBtn>
      {error && <p className="w-full text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

/* ─── Stock row ─── */

function StockRow({ stock, stocks, onChanged }: { stock: StockDto; stocks: StockDto[]; onChanged: () => void }) {
  const [panel, setPanel] = useState<'none' | 'move' | 'convert'>('none')
  return (
    <div className="border-b border-line py-[8px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-12 text-[14px] font-medium tracking-[.04em] text-ink">{stock.size_label}</span>
        {stock.location_id && <span className="text-[11.5px] text-dim">{stock.location_id}</span>}
        {stock.opened !== 0 && <span className="font-mono text-[9.5px] tracking-[.1em] text-dim">已开封</span>}
        {stock.moisture_status !== 'ok' && (
          <span className={`font-mono text-[9.5px] tracking-[.1em] ${stock.moisture_status === 'danger' ? 'text-wine-ink' : 'text-warn'}`}>
            潮湿{stock.moisture_status === 'danger' ? '危险' : '预警'}
          </span>
        )}
        <Leader />
        <span className="font-mono text-[13px] text-ink">{stock.quantity} 张</span>
        <button
          type="button"
          className={`${actionBtn} text-wine-ink`}
          onClick={() => setPanel(panel === 'move' ? 'none' : 'move')}
        >
          出入库
        </button>
        <button
          type="button"
          className={`${actionBtn} text-dim`}
          onClick={() => setPanel(panel === 'convert' ? 'none' : 'convert')}
        >
          裁切
        </button>
      </div>
      {panel === 'move' && <MovementPanel stock={stock} onDone={() => { setPanel('none'); onChanged() }} />}
      {panel === 'convert' && <ConvertPanel stock={stock} stocks={stocks} onDone={() => { setPanel('none'); onChanged() }} />}
    </div>
  )
}

/* ─── New stock form (with optional purchase) ─── */

function NewStockForm({ refs, onCreated }: { refs: RefDto; onCreated: () => void }) {
  const [paperId, setPaperId] = useState('')
  const [sizeKey, setSizeKey] = useState('')
  const [location, setLocation] = useState('')
  const [withPurchase, setWithPurchase] = useState(false)
  const [purchaseQty, setPurchaseQty] = useState('')
  const [currency, setCurrency] = useState('')
  const [amount, setAmount] = useState('')
  const [costC, setCostC] = useState('')
  const [rateNote, setRateNote] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (paperId === '' || sizeKey === '') return
    const res = await send<{ id: string }>('POST', '/api/inventory/stocks', {
      paper_id: Number(paperId),
      size_key: sizeKey,
      location_id: location.trim() === '' ? null : location.trim(),
    })
    if (!res.ok) {
      setNotice(res.status === 409 ? '该纸×尺寸×位置的档案已存在' : '创建失败')
      return
    }
    if (withPurchase) {
      const pqty = Math.trunc(Number(purchaseQty))
      if (pqty > 0) {
        const payload: Record<string, unknown> = {
          action: 'purchase',
          quantity_delta: pqty,
          ...buildPurchasePayload(currency, amount, costC, rateNote),
        }
        const moveRes = await send('POST', `/api/inventory/stocks/${res.data.id}/movements`, payload)
        if (moveRes.ok) {
          setNotice('档案已建，采购已记账')
        } else {
          setNotice('档案已建，但采购记账失败')
        }
      } else {
        setNotice('档案已建（采购数量须为正整数，跳过记账）')
      }
    } else {
      setNotice('档案已建（数量从 0 起，用「采购入库」记账）')
    }
    toast('库存档案已创建', 'ok')
    onCreated()
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 space-y-3 border border-ink bg-card p-4">
      <span className="block font-mono text-[10px] tracking-[.14em] text-dim">NEW STOCK FILE</span>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="纸张">
          <select className={specInput} value={paperId} onChange={(e) => setPaperId(e.target.value)}>
            <option value="">— 选择 —</option>
            {refs.papers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="尺寸">
          <select className={specInput} value={sizeKey} onChange={(e) => setSizeKey(e.target.value)}>
            <option value="">— 选择 —</option>
            {refs.sizes.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="存放位置（可空）">
          <input type="text" className={specInput} value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={withPurchase} onChange={(e) => setWithPurchase(e.target.checked)} />
        建档同时采购入库
      </label>
      {withPurchase && (
        <div className="space-y-3 border-t border-line pt-3">
          <Field label="采购数量（张）">
            <input type="number" min={1} required={withPurchase} className={specInput} value={purchaseQty} onChange={(e) => setPurchaseQty(e.target.value)} />
          </Field>
          <PurchaseFields
            currency={currency} setCurrency={setCurrency}
            amount={amount} setAmount={setAmount}
            costC={costC} setCostC={setCostC}
            note={rateNote} setNote={setRateNote}
          />
        </div>
      )}
      <PillBtn>{withPurchase ? '新建并采购' : '新建库存档案'}</PillBtn>
      {notice && <p className="text-[12px] text-wine-ink">{notice}</p>}
    </form>
  )
}

/* ─── Stocks tab ─── */

function StocksTab({ stocks, refs, onChanged }: { stocks: StockDto[]; refs: RefDto | null; onChanged: () => void }) {
  const byPaper = useMemo(() => {
    const groups = new Map<number, { name: string; rows: StockDto[] }>()
    for (const s of stocks) {
      let g = groups.get(s.paper_id)
      if (!g) {
        g = { name: s.paper_name, rows: [] }
        groups.set(s.paper_id, g)
      }
      g.rows.push(s)
    }
    return [...groups.values()]
  }, [stocks])

  return (
    <div className="pt-5">
      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        {byPaper.map((g) => (
          <div key={g.name} className="mb-6">
            <div className="border-b border-ink pb-1.5 text-[14px] font-medium tracking-[.04em] text-ink">{g.name}</div>
            {g.rows.map((s) => (
              <StockRow key={s.id} stock={s} stocks={stocks} onChanged={onChanged} />
            ))}
          </div>
        ))}
      </div>
      {refs && <NewStockForm refs={refs} onCreated={onChanged} />}
      <div className="mt-3 text-right">
        <a href="/api/inventory/stocks/export" className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink">导出 XLSX ↧</a>
      </div>
    </div>
  )
}

/* ─── Consumable edit panel ─── */

function ConsumableEditPanel({ item, onDone }: { item: ConsumableDto; onDone: () => void }) {
  const [name, setName] = useState(item.name)
  const [qty, setQty] = useState(String(item.quantity))
  const [costC, setCostC] = useState(String(item.unit_cost_c))
  const [supplier, setSupplier] = useState(item.supplier ?? '')
  const [threshold, setThreshold] = useState(String(item.alert_threshold_bp))
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const res = await send('PATCH', `/api/inventory/consumables/${item.id}`, {
      name: name.trim(),
      quantity: Math.trunc(Number(qty)),
      unit_cost_c: Math.trunc(Number(costC)),
      supplier: supplier.trim() === '' ? null : supplier.trim(),
      alert_threshold_bp: Math.trunc(Number(threshold)),
    })
    if (res.ok) { toast('耗材已更新', 'ok'); onDone() }
    else setError('保存失败')
  }

  const archive = async () => {
    const res = await send('PATCH', `/api/inventory/consumables/${item.id}`, { archived: true })
    if (res.ok) { toast('耗材已归档', 'ok'); onDone() }
    else setError('归档失败')
  }

  return (
    <form onSubmit={(e) => void save(e)} className="mt-2 space-y-3 border border-line bg-card p-3.5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="名称">
          <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="备品件数">
          <input type="number" min={0} required className={specInput} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="单价_c（/件）">
          <input type="number" min={0} required className={specInput} value={costC} onChange={(e) => setCostC(e.target.value)} />
        </Field>
        <Field label="供应商">
          <input type="text" className={specInput} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <Field label="预警阈值 bp">
          <input type="number" min={0} max={10000} className={specInput} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <PillBtn>保存</PillBtn>
        <button type="button" onClick={() => void archive()} className={`${actionBtn} text-warn`}>归档</button>
      </div>
      {error && <p className="text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

/* ─── Consumables tab ─── */

function ConsumablesTab({ consumables, refs, onChanged }: { consumables: ConsumableDto[]; refs: RefDto | null; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState('toner')
  const [printerId, setPrinterId] = useState('')
  const [qty, setQty] = useState('0')
  const [costC, setCostC] = useState('0')
  const [supplier, setSupplier] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !printerId) return
    const res = await send('POST', '/api/inventory/consumables', {
      name: name.trim(),
      type,
      printer_id: Number(printerId),
      quantity: Math.trunc(Number(qty)),
      cost_model: 'per_job_rule',
      unit_cost_c: Math.trunc(Number(costC)),
      supplier: supplier.trim() === '' ? null : supplier.trim(),
    })
    if (res.ok) {
      setNotice('耗材已登记')
      setName(''); setQty('0'); setCostC('0'); setSupplier('')
      toast('耗材已登记', 'ok')
      onChanged()
    } else {
      setNotice(res.status === 409 ? '设备不存在' : '创建失败')
    }
  }

  return (
    <div className="pt-5">
      {consumables.length === 0 ? (
        <p className="py-2 text-[13px] text-dim">无在册耗材</p>
      ) : (
        consumables.map((c) => (
          <div key={c.id}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-[9px]">
              <span className="min-w-16 font-mono text-[11px] tracking-[.08em] text-dim">{c.printer_code}</span>
              <span className="text-[14px] font-medium tracking-[.04em] text-ink">{c.name}</span>
              <span className="text-[11.5px] text-dim">
                {CONSUMABLE_TYPE_LABEL[c.type] ?? c.type} · 备品 ×{c.quantity} · {c.unit_cost_display}/件
              </span>
              <Leader />
              <button
                type="button"
                className={`${actionBtn} text-wine-ink`}
                onClick={() => setEditing(editing === c.id ? null : c.id)}
              >
                {editing === c.id ? '收起' : '编辑'}
              </button>
            </div>
            {editing === c.id && (
              <ConsumableEditPanel item={c} onDone={() => { setEditing(null); onChanged() }} />
            )}
          </div>
        ))
      )}
      <div className="mt-3 text-right">
        <a href="/api/inventory/consumables/export" className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink">导出 XLSX ↧</a>
      </div>

      {refs && (
        <form onSubmit={(e) => void create(e)} className="mt-6 space-y-3 border border-ink bg-card p-4">
          <span className="block font-mono text-[10px] tracking-[.14em] text-dim">NEW CONSUMABLE</span>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="名称">
              <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="类型">
              <select className={specInput} value={type} onChange={(e) => setType(e.target.value)}>
                {Object.entries(CONSUMABLE_TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="所属设备">
              <select className={specInput} value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
                <option value="">— 选择 —</option>
                {refs.printers.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} {p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="备品件数">
              <input type="number" min={0} className={specInput} value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            <Field label="单价_c（/件）">
              <input type="number" min={0} className={specInput} value={costC} onChange={(e) => setCostC(e.target.value)} />
            </Field>
            <Field label="供应商">
              <input type="text" className={specInput} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </Field>
          </div>
          <PillBtn>登记耗材</PillBtn>
          {notice && <p className="text-[12px] text-wine-ink">{notice}</p>}
        </form>
      )}
    </div>
  )
}

/* ─── Main body ─── */

function InventoryBody() {
  const [tab, setTab] = useState<TabKey>('stocks')
  const [stocks, setStocks] = useState<StockDto[] | null>(null)
  const [consumables, setConsumables] = useState<ConsumableDto[] | null>(null)
  const [log, setLog] = useState<LogDto[] | null>(null)
  const [refs, setRefs] = useState<RefDto | null>(null)
  const [actionFilter, setActionFilter] = useState('')

  const reload = useCallback(() => {
    void send<StockDto[]>('GET', '/api/inventory/stocks').then((r) => r.ok && setStocks(r.data))
    void send<ConsumableDto[]>('GET', '/api/inventory/consumables').then((r) => r.ok && setConsumables(r.data))
    void send<{ data: LogDto[]; total: number }>('GET', '/api/inventory/log').then((r) => r.ok && setLog(r.data.data))
  }, [])

  useEffect(() => {
    let cancelled = false
    reload()
    void Promise.all([
      send<RefDto['papers']>('GET', '/api/pricing/papers'),
      send<RefDto['sizes']>('GET', '/api/pricing/sizes'),
      send<Array<{ id: number; code: string; name: string }>>('GET', '/api/equipment'),
    ]).then(([p, s, pr]) => {
      if (p.ok && s.ok && pr.ok && !cancelled) setRefs({ papers: p.data, sizes: s.data, printers: pr.data })
    })
    return () => { cancelled = true }
  }, [reload])

  const targetLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of stocks ?? []) m.set(s.id, `${s.paper_name} ${s.size_label}`)
    for (const c of consumables ?? []) m.set(c.id, c.name)
    return m
  }, [stocks, consumables])

  const filteredLog = useMemo(
    () => (log ?? []).filter((l) => actionFilter === '' || l.action === actionFilter),
    [log, actionFilter],
  )

  if (!stocks || !consumables || !log) return <Skeleton />

  const counts: Record<TabKey, number> = {
    stocks: stocks.length,
    consumables: consumables.length,
    timeline: filteredLog.length,
  }
  const tabsWithCounts = TABS.map((t) => ({ ...t, count: counts[t.key] }))

  return (
    <MagSec title="库存管理">
      <TabBar tabs={tabsWithCounts} active={tab} onChange={(k) => setTab(k as TabKey)} />
      {tab === 'stocks' && <StocksTab stocks={stocks} refs={refs} onChanged={reload} />}
      {tab === 'consumables' && <ConsumablesTab consumables={consumables} refs={refs} onChanged={reload} />}
      {tab === 'timeline' && (
        <TimelineSection filteredLog={filteredLog} actionFilter={actionFilter} setActionFilter={setActionFilter} targetLabel={targetLabel} />
      )}
    </MagSec>
  )
}

export default function AdminInventory() {
  return <AdminGate>{() => <InventoryBody />}</AdminGate>
}
