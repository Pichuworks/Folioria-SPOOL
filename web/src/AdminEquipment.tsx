import { useCallback, useEffect, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Field, Leader, MagSec, PillBtn, Skeleton, SpecRow, specInput } from './spec'

interface PrinterDto {
  id: number
  code: string
  name: string
  type: string
  location: string | null
  status: string
  total_pages: number
  equipment_cost_c: number
  monthly_cost_c: number
  last_calibration_at: string | null
  last_calibration_pages: number
  calibration_interval_pages: number | null
  calibration_interval_days: number | null
  calibration_due: boolean
  equipment_cost_display: string
  monthly_cost_display: string
}

interface MaintDto {
  id: string
  type: string
  occurred_at: string
  notes: string | null
  next_due: string | null
  cost: number | null
  final_usage: number | null
  cost_display: string | null
}

interface ConsumableDto {
  id: string
  name: string
  printer_id: number
  quantity: number
  current_usage_pages: number
}

const MAINT_LABEL: Record<string, string> = {
  calibration: '校准',
  toner_change: '换墨/碳粉',
  nozzle_check: '喷嘴检查',
  head_clean: '打印头清洗',
  fuser_replace: '定影更换',
  drum_replace: '硒鼓更换',
  firmware_update: '固件更新',
  deep_clean: '深度清洁',
  other: '其他',
}

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  standby: '待机',
  maintenance: '维护中',
  offline: '离线',
}

const actionBtn = 'font-mono text-[10px] tracking-[.14em] hover:opacity-70'

function MaintForm({
  printer,
  consumables,
  onDone,
}: {
  printer: PrinterDto
  consumables: ConsumableDto[]
  onDone: () => void
}) {
  const [type, setType] = useState('calibration')
  const [consumableId, setConsumableId] = useState('')
  const [finalUsage, setFinalUsage] = useState('')
  const [cost, setCost] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mine = consumables.filter((c) => c.printer_id === printer.id)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const body: Record<string, unknown> = { type }
    if (notes.trim() !== '') body['notes'] = notes.trim()
    if (cost.trim() !== '') {
      const n = Math.trunc(Number(cost))
      if (n < 0) {
        setError('支出须为非负整数（金额层）')
        return
      }
      body['cost'] = n
    }
    if (type === 'toner_change') {
      const fu = Math.trunc(Number(finalUsage))
      if (consumableId === '' || finalUsage.trim() === '' || fu < 0) {
        setError('换装必须选择耗材并录入旧件读数')
        return
      }
      body['consumable_id'] = consumableId
      body['final_usage'] = fu
    }
    const res = await send('POST', `/api/equipment/${printer.id}/maintenance`, body)
    if (res.ok) onDone()
    else {
      setError(
        res.status === 409
          ? '无备品库存，无法换装'
          : res.status === 422
            ? '输入不完整（换装需耗材 + 旧件读数）'
            : '记录失败',
      )
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-wrap items-end gap-3 border border-line bg-card p-3.5">
      <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">LOG MAINTENANCE</span>
      <Field label="类型">
        <select className={specInput} value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(MAINT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </Field>
      {type === 'toner_change' && (
        <>
          <Field label="耗材">
            <select className={specInput} value={consumableId} onChange={(e) => setConsumableId(e.target.value)}>
              <option value="">— 选择 —</option>
              {mine.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（备品 ×{c.quantity}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="旧件读数（面）">
            <input type="number" min={0} className={specInput} value={finalUsage} onChange={(e) => setFinalUsage(e.target.value)} />
          </Field>
        </>
      )}
      <Field label="外部支出（整数，可空）">
        <input type="number" min={0} className={specInput} value={cost} onChange={(e) => setCost(e.target.value)} />
      </Field>
      <Field label="备注">
        <input type="text" className={specInput} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <PillBtn>落档</PillBtn>
      {error && <p className="w-full text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

function ProfileEditPanel({ printer, onDone }: { printer: PrinterDto; onDone: () => void }) {
  const [location, setLocation] = useState(printer.location ?? '')
  const [equipCost, setEquipCost] = useState(String(printer.equipment_cost_c))
  const [monthlyCost, setMonthlyCost] = useState(String(printer.monthly_cost_c))
  const [intPages, setIntPages] = useState(printer.calibration_interval_pages == null ? '' : String(printer.calibration_interval_pages))
  const [intDays, setIntDays] = useState(printer.calibration_interval_days == null ? '' : String(printer.calibration_interval_days))
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const ec = Math.trunc(Number(equipCost))
    const mc = Math.trunc(Number(monthlyCost))
    if (ec < 0 || mc < 0) {
      setError('成本须为非负整数（_c）')
      return
    }
    const parseInterval = (v: string): number | null | false => {
      if (v.trim() === '') return null
      const n = Math.trunc(Number(v))
      return n >= 1 ? n : false
    }
    const ip = parseInterval(intPages)
    const idays = parseInterval(intDays)
    if (ip === false || idays === false) {
      setError('校准间隔须为正整数或留空（该维度不触发）')
      return
    }
    const res = await send('PATCH', `/api/equipment/${printer.id}`, {
      location: location.trim() === '' ? null : location.trim(),
      equipment_cost_c: ec,
      monthly_cost_c: mc,
      calibration_interval_pages: ip,
      calibration_interval_days: idays,
    })
    if (res.ok) onDone()
    else setError('保存失败')
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-wrap items-end gap-3 border border-line bg-card p-3.5">
      <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">EDIT PROFILE</span>
      <Field label="位置">
        <input type="text" className={specInput} value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <Field label="设备成本 _c（参与折旧摊薄）">
        <input type="number" min={0} className={specInput} value={equipCost} onChange={(e) => setEquipCost(e.target.value)} />
      </Field>
      <Field label="月成本 _c">
        <input type="number" min={0} className={specInput} value={monthlyCost} onChange={(e) => setMonthlyCost(e.target.value)} />
      </Field>
      <Field label="校准间隔·页（空=不触发）">
        <input type="number" min={1} className={specInput} value={intPages} onChange={(e) => setIntPages(e.target.value)} />
      </Field>
      <Field label="校准间隔·天（空=不触发）">
        <input type="number" min={1} className={specInput} value={intDays} onChange={(e) => setIntDays(e.target.value)} />
      </Field>
      <PillBtn>保存档案</PillBtn>
      {error && <p className="w-full text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

function PrinterCard({
  printer,
  consumables,
  onChanged,
}: {
  printer: PrinterDto
  consumables: ConsumableDto[]
  onChanged: () => void
}) {
  const [panel, setPanel] = useState<'none' | 'edit' | 'maint'>('none')
  const [events, setEvents] = useState<MaintDto[] | null>(null)

  const loadEvents = useCallback(() => {
    void send<MaintDto[]>('GET', `/api/equipment/${printer.id}/maintenance`).then(
      (r) => r.ok && setEvents(r.data),
    )
  }, [printer.id])

  useEffect(loadEvents, [loadEvents])

  const setStatus = async (status: string) => {
    const res = await send('PATCH', `/api/equipment/${printer.id}`, { status })
    if (res.ok) onChanged()
  }

  return (
    <div className="mb-7 border border-ink p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink pb-2.5">
        <span className="text-[18px] font-semibold text-ink">{printer.code}</span>
        <span className="text-[13px] text-dim">{printer.name}</span>
        {printer.location && <span className="text-[11.5px] text-dim">{printer.location}</span>}
        {printer.calibration_due && (
          <span className="font-mono text-[10px] tracking-[.1em] text-warn">校准到期</span>
        )}
        <Leader />
        <select
          className="border border-line bg-card px-2 py-1 font-mono text-[11px] text-ink outline-none"
          value={printer.status}
          onChange={(e) => void setStatus(e.target.value)}
        >
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <button type="button" className={`${actionBtn} text-wine-ink`} onClick={() => setPanel(panel === 'edit' ? 'none' : 'edit')}>
          档案
        </button>
        <button type="button" className={`${actionBtn} text-wine-ink`} onClick={() => setPanel(panel === 'maint' ? 'none' : 'maint')}>
          记维护
        </button>
      </div>

      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <SpecRow label="累计输出" value={`${printer.total_pages} P`} />
          <SpecRow label="设备成本" note="折旧摊薄基数" value={printer.equipment_cost_display} />
          <SpecRow label="月成本" value={printer.monthly_cost_display} />
        </div>
        <div>
          <SpecRow
            label="上次校准"
            value={printer.last_calibration_at ? `${printer.last_calibration_at.slice(0, 10)} @ ${printer.last_calibration_pages}P` : '未记录'}
          />
          <SpecRow
            label="校准间隔"
            value={
              printer.calibration_interval_pages == null && printer.calibration_interval_days == null
                ? '不触发'
                : [
                    printer.calibration_interval_pages != null ? `${printer.calibration_interval_pages}P` : null,
                    printer.calibration_interval_days != null ? `${printer.calibration_interval_days}天` : null,
                  ]
                    .filter(Boolean)
                    .join(' / ')
            }
          />
        </div>
      </div>

      {panel === 'edit' && <ProfileEditPanel printer={printer} onDone={() => { setPanel('none'); onChanged() }} />}
      {panel === 'maint' && (
        <MaintForm
          printer={printer}
          consumables={consumables}
          onDone={() => {
            setPanel('none')
            loadEvents()
            onChanged()
          }}
        />
      )}

      <div className="mt-4">
        <div className="font-mono text-[10px] tracking-[.14em] text-dim">MAINTENANCE LOG</div>
        {!events || events.length === 0 ? (
          <p className="py-2 text-[12px] text-dim">暂无维护记录</p>
        ) : (
          events.slice(0, 8).map((ev) => (
            <div key={ev.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-[7px]">
              <span className="font-mono text-[10px] tracking-[.08em] text-dim">{ev.occurred_at.slice(0, 10)}</span>
              <span className="text-[13px] font-medium text-ink">{MAINT_LABEL[ev.type] ?? ev.type}</span>
              {ev.final_usage != null && <span className="text-[11.5px] text-dim">旧件 {ev.final_usage}P</span>}
              {ev.notes && <span className="text-[11.5px] text-dim">{ev.notes}</span>}
              <Leader />
              {ev.cost_display && <span className="font-mono text-[12px] text-ink">{ev.cost_display}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function EquipmentBody() {
  const [printers, setPrinters] = useState<PrinterDto[] | null>(null)
  const [consumables, setConsumables] = useState<ConsumableDto[] | null>(null)

  const reload = useCallback(() => {
    void send<PrinterDto[]>('GET', '/api/equipment').then((r) => r.ok && setPrinters(r.data))
    void send<ConsumableDto[]>('GET', '/api/inventory/consumables').then((r) => r.ok && setConsumables(r.data))
  }, [])
  useEffect(reload, [reload])

  if (!printers || !consumables) return <Skeleton />

  return (
    <MagSec tag="设备" title="设备档案" note={`${printers.length} UNITS · DUAL-TRIGGER CALIBRATION`}>
      {printers.map((p) => (
        <PrinterCard key={p.id} printer={p} consumables={consumables} onChanged={reload} />
      ))}
      <div className="mt-3 text-right">
        <a href="/api/equipment/export" className="font-mono text-[10.5px] tracking-[.12em] text-dim underline hover:text-wine-ink">导出 XLSX ↧</a>
      </div>
    </MagSec>
  )
}

export default function AdminEquipment() {
  return <AdminGate>{() => <EquipmentBody />}</AdminGate>
}
