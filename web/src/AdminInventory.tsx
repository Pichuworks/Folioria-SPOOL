import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Field, Leader, MagSec, Paginator, PillBtn, Skeleton, specInput, usePagination } from './spec'

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
  quantity: number
  cost_model: string
  rated_life_pages: number | null
  current_usage_pages: number
  unit_cost_display: string
  alert_threshold_bp: number
  printer_code: string
  remaining_bp: number | null
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
}

const ACTION_LABEL: Record<string, string> = {
  purchase: '采购入库',
  consume: '消耗出库',
  adjust: '盘点调整',
  scrap: '报废',
  return: '退回入库',
  convert: '裁切转换',
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

function TimelineSection({ filteredLog, actionFilter, setActionFilter, targetLabel }: {
  filteredLog: LogDto[]
  actionFilter: string
  setActionFilter: (v: string) => void
  targetLabel: Map<string, string>
}) {
  const { page, totalPages, paged, setPage } = usePagination(filteredLog, 50)

  return (
    <MagSec tag="03" title="出入库时间线" note={`${filteredLog.length} 条`}>
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
    </MagSec>
  )
}

const actionBtn = 'font-mono text-[10px] tracking-[.14em] hover:opacity-70'

function MovementPanel({ stock, onDone }: { stock: StockDto; onDone: () => void }) {
  const [action, setAction] = useState('purchase')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const n = Math.trunc(Number(qty))
    if (!Number.isSafeInteger(n) || n === 0) {
      setError('数量须为非零整数')
      return
    }
    const delta = action === 'adjust' ? n : ['consume', 'scrap'].includes(action) ? -Math.abs(n) : Math.abs(n)
    const res = await send('POST', `/api/inventory/stocks/${stock.id}/movements`, {
      action,
      quantity_delta: delta,
      reason: reason.trim() === '' ? null : reason.trim(),
    })
    if (res.ok) onDone()
    else setError(res.status === 409 ? '账面不足，无法出库' : '录入失败，请检查输入')
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-2 flex flex-wrap items-end gap-3 border border-line bg-card p-3.5">
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
      {error && <p className="w-full text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

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
    if (res.ok) onDone()
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

function StockRow({ stock, stocks, onChanged }: { stock: StockDto; stocks: StockDto[]; onChanged: () => void }) {
  const [panel, setPanel] = useState<'none' | 'move' | 'convert'>('none')
  return (
    <div className="border-b border-line py-[8px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-12 text-[14px] font-medium text-ink">{stock.size_label}</span>
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

function NewStockForm({ refs, onCreated }: { refs: RefDto; onCreated: () => void }) {
  const [paperId, setPaperId] = useState('')
  const [sizeKey, setSizeKey] = useState('')
  const [location, setLocation] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (paperId === '' || sizeKey === '') return
    const res = await send('POST', '/api/inventory/stocks', {
      paper_id: Number(paperId),
      size_key: sizeKey,
      location_id: location.trim() === '' ? null : location.trim(),
    })
    if (res.ok) {
      setNotice('档案已建（数量从 0 起，用「采购入库」记账）')
      onCreated()
    } else {
      setNotice(res.status === 409 ? '该纸×尺寸×位置的档案已存在' : '创建失败')
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
      <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW STOCK FILE</span>
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
      <PillBtn>新建库存档案</PillBtn>
      {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
    </form>
  )
}

function LifeBar({ c }: { c: ConsumableDto }) {
  if (c.remaining_bp == null) {
    return <span className="font-mono text-[10px] tracking-[.1em] text-dim">按作业计价</span>
  }
  const low = c.remaining_bp <= c.alert_threshold_bp
  return (
    <span className="flex items-center gap-2">
      <span className="h-[8px] w-28 border border-line bg-paper">
        <span
          className={`block h-full ${low ? 'bg-warn' : 'bg-wine'}`}
          style={{ width: `${c.remaining_bp / 100}%` }}
        />
      </span>
      <span className={`font-mono text-[11px] ${low ? 'text-warn' : 'text-ink'}`}>
        {(c.remaining_bp - (c.remaining_bp % 100)) / 100}%
      </span>
    </span>
  )
}

function InventoryBody() {
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
    reload()
    void Promise.all([
      send<RefDto['papers']>('GET', '/api/pricing/papers'),
      send<RefDto['sizes']>('GET', '/api/pricing/sizes'),
    ]).then(([p, s]) => {
      if (p.ok && s.ok) setRefs({ papers: p.data, sizes: s.data })
    })
  }, [reload])

  const byPaper = useMemo(() => {
    const groups = new Map<number, { name: string; rows: StockDto[] }>()
    for (const s of stocks ?? []) {
      let g = groups.get(s.paper_id)
      if (!g) {
        g = { name: s.paper_name, rows: [] }
        groups.set(s.paper_id, g)
      }
      g.rows.push(s)
    }
    return [...groups.values()]
  }, [stocks])

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

  return (
    <div>
      <MagSec tag="01" title="纸张库存" note={`${stocks.length} FILES`}>
        <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
          {byPaper.map((g) => (
            <div key={g.name} className="mb-6">
              <div className="border-b border-ink pb-1.5 text-[14px] font-medium text-ink">{g.name}</div>
              {g.rows.map((s) => (
                <StockRow key={s.id} stock={s} stocks={stocks} onChanged={reload} />
              ))}
            </div>
          ))}
        </div>
        {refs && <NewStockForm refs={refs} onCreated={reload} />}
        <div className="mt-3 text-right">
          <a href="/api/inventory/stocks/export" className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink">导出 XLSX ↧</a>
        </div>
      </MagSec>

      <MagSec tag="02" title="耗材" note="LIFE GAUGE">
        {consumables.length === 0 ? (
          <p className="py-2 text-[13px] text-dim">无在册耗材</p>
        ) : (
          consumables.map((c) => (
            <div key={c.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-[9px]">
              <span className="min-w-16 font-mono text-[11px] tracking-[.08em] text-dim">{c.printer_code}</span>
              <span className="text-[14px] font-medium text-ink">{c.name}</span>
              <span className="text-[11.5px] text-dim">备品 ×{c.quantity} · {c.unit_cost_display}/件</span>
              <Leader />
              {c.rated_life_pages != null && (
                <span className="font-mono text-[11px] text-dim">
                  {c.current_usage_pages}/{c.rated_life_pages}P
                </span>
              )}
              <LifeBar c={c} />
            </div>
          ))
        )}
        <div className="mt-3 text-right">
          <a href="/api/inventory/consumables/export" className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink">导出 XLSX ↧</a>
        </div>
      </MagSec>

      <TimelineSection filteredLog={filteredLog} actionFilter={actionFilter} setActionFilter={setActionFilter} targetLabel={targetLabel} />
    </div>
  )
}

export default function AdminInventory() {
  return <AdminGate>{() => <InventoryBody />}</AdminGate>
}
