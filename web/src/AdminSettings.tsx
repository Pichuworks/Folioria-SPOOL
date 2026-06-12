import { useEffect, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Field, MagSec, PillBtn, SpecRow, specInput } from './spec'

interface SettingsDto {
  base_currency: string
  min_margin_bp: number
  unify_pricing: boolean
  force_min_margin: boolean
  overhead_dep_months: number
  overhead_month_volume: number
  quote_valid_days: number
  initialized_at: string | null
}

function SettingsBody() {
  const [settings, setSettings] = useState<SettingsDto | null>(null)
  const [form, setForm] = useState<SettingsDto | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void send<SettingsDto>('GET', '/api/settings').then((r) => {
      if (r.ok) {
        setSettings(r.data)
        setForm(r.data)
      }
    })
  }, [])

  if (!settings || !form) return <p className="pt-13 text-[14px] text-dim">设置加载中…</p>

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (form.min_margin_bp < 0 || form.min_margin_bp > 9999) {
      setNotice('毛利下限 0–9999 基点（10000 会让地板价除零）')
      return
    }
    const res = await send<SettingsDto>('PATCH', '/api/settings', {
      min_margin_bp: form.min_margin_bp,
      unify_pricing: form.unify_pricing,
      force_min_margin: form.force_min_margin,
      overhead_dep_months: form.overhead_dep_months,
      overhead_month_volume: form.overhead_month_volume,
      quote_valid_days: form.quote_valid_days,
    })
    if (res.ok) {
      setSettings(res.data)
      setForm(res.data)
      setNotice('已保存——全部报价即时按新参数推导')
    } else setNotice('保存失败，检查取值范围')
  }

  const num = (k: 'min_margin_bp' | 'overhead_dep_months' | 'overhead_month_volume' | 'quote_valid_days') =>
    (e: { target: { value: string } }) =>
      setForm((f) => (f ? { ...f, [k]: Math.trunc(Number(e.target.value) || 0) } : f))

  return (
    <div>
      <MagSec tag="01" title="实例" note="IMMUTABLE">
        <SpecRow label="基准货币" note="产生业务数据后锁定，换币种 = 新实例" value={settings.base_currency} strong />
        <SpecRow label="初始化时间" value={settings.initialized_at?.slice(0, 10) ?? '—'} />
      </MagSec>

      <MagSec tag="02" title="定价参数" note="C7 / C9">
        <form onSubmit={(e) => void submit(e)} className="max-w-xl space-y-4 border border-ink bg-card p-6">
          <Field label="最低毛利率（基点，6700 = 67%）">
            <input type="number" min={0} max={9999} required className={specInput} value={form.min_margin_bp} onChange={num('min_margin_bp')} />
          </Field>
          <Field label="设备折旧月数">
            <input type="number" min={1} required className={specInput} value={form.overhead_dep_months} onChange={num('overhead_dep_months')} />
          </Field>
          <Field label="月摊薄基准张数">
            <input type="number" min={1} required className={specInput} value={form.overhead_month_volume} onChange={num('overhead_month_volume')} />
          </Field>
          <Field label="报价有效天数">
            <input type="number" min={1} required className={specInput} value={form.quote_valid_days} onChange={num('quote_valid_days')} />
          </Field>
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={form.unify_pricing}
              onChange={(e) => setForm((f) => (f ? { ...f, unify_pricing: e.target.checked } : f))}
            />
            统一定价（内部价缺省同对外）
          </label>
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={form.force_min_margin}
              onChange={(e) => setForm((f) => (f ? { ...f, force_min_margin: e.target.checked } : f))}
            />
            强制毛利下限（开启时手动价被抬至地板价并标记 forced）
          </label>
          <PillBtn full>保存参数</PillBtn>
          {notice && <p className="text-[12.5px] text-wine-ink">{notice}</p>}
        </form>
      </MagSec>
    </div>
  )
}

export default function AdminSettings() {
  return <AdminGate>{() => <SettingsBody />}</AdminGate>
}
