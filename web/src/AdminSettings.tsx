import { useEffect, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Field, MagSec, PillBtn, Skeleton, SpecRow, specInput } from './spec'

interface SettingsDto {
  base_currency: string
  min_margin_bp: number
  unify_pricing: boolean
  force_min_margin: boolean
  require_email_verification: boolean
  guest_orders_open: boolean
  overhead_dep_months: number
  overhead_month_volume: number
  quote_valid_days: number
  initialized_at: string | null
}

interface SystemInfoDto {
  node_version: string
  db_size: string
  user_count: number
  order_count: number
  job_count: number
  email_configured: boolean
}

const PERM_MATRIX: Array<{ label: string; customer: string; member: string; admin: string }> = [
  { label: '下单域访问', customer: '是', member: '是', admin: '是' },
  { label: '管理域访问', customer: '否', member: '否', admin: '是' },
  { label: '适用价格', customer: '对外价', member: '内部价', admin: '全部' },
  { label: '下单标记', customer: '—', member: 'is_internal', admin: '—' },
  { label: '订单可见', customer: '仅自己', member: '仅自己', admin: '全部' },
  { label: '成本/毛利可见', customer: '否', member: '否', admin: '是' },
]

function SettingsBody() {
  const [settings, setSettings] = useState<SettingsDto | null>(null)
  const [form, setForm] = useState<SettingsDto | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfoDto | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void send<SettingsDto>('GET', '/api/settings').then((r) => {
      if (r.ok) {
        setSettings(r.data)
        setForm(r.data)
      }
    })
    void send<SystemInfoDto>('GET', '/api/settings/system-info').then((r) => r.ok && setSysInfo(r.data))
  }, [])

  if (!settings || !form) return <Skeleton />

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
      require_email_verification: form.require_email_verification,
      guest_orders_open: form.guest_orders_open,
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
      <MagSec title="实例">
        <SpecRow label="基准货币" note="产生业务数据后锁定，换币种 = 新实例" value={settings.base_currency} strong />
        <SpecRow label="初始化时间" value={settings.initialized_at?.slice(0, 10) ?? '—'} />
      </MagSec>

      <MagSec title="定价参数">
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
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={form.require_email_verification}
              onChange={(e) =>
                setForm((f) => (f ? { ...f, require_email_verification: e.target.checked } : f))
              }
            />
            要求邮箱验证后方可下单（默认关）
          </label>
          {form.require_email_verification && (
            <p className="text-[11.5px] leading-[1.7] text-wine-ink">
              ⚠ 开启后，未配置邮件发送（SPOOL_RESEND_API_KEY）的实例将使新注册用户收不到验证链接而无法下单。
            </p>
          )}
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={form.guest_orders_open}
              onChange={(e) => setForm((f) => (f ? { ...f, guest_orders_open: e.target.checked } : f))}
            />
            允许免登录（访客）下单（默认关）
          </label>
          <PillBtn full>保存参数</PillBtn>
          {notice && <p className="text-[12.5px] text-wine-ink">{notice}</p>}
        </form>
      </MagSec>

      <MagSec title="角色权限">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-ink">
                <th className="py-2 pr-4 font-mono text-[10px] tracking-[.12em] text-dim">权限项</th>
                <th className="py-2 px-3 font-mono text-[10px] tracking-[.12em] text-dim">顾客</th>
                <th className="py-2 px-3 font-mono text-[10px] tracking-[.12em] text-dim">内部成员</th>
                <th className="py-2 px-3 font-mono text-[10px] tracking-[.12em] text-dim">管理员</th>
              </tr>
            </thead>
            <tbody>
              {PERM_MATRIX.map((row) => (
                <tr key={row.label} className="border-b border-line">
                  <td className="py-2 pr-4 text-ink">{row.label}</td>
                  <td className="py-2 px-3 text-dim">{row.customer}</td>
                  <td className="py-2 px-3 text-dim">{row.member}</td>
                  <td className="py-2 px-3 text-wine-ink">{row.admin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11.5px] leading-[1.7] text-dim">
          member 与 customer 的唯一区别：下单时适用内部价（internal_sell_c），订单标记 is_internal，月报单独归类。管理域全部功能仅限 admin。
        </p>
      </MagSec>

      {sysInfo && (
        <MagSec title="系统信息">
          <SpecRow label="Node.js" value={sysInfo.node_version} />
          <SpecRow label="数据库大小" value={sysInfo.db_size} />
          <SpecRow label="用户数" value={sysInfo.user_count} />
          <SpecRow label="订单数" value={sysInfo.order_count} />
          <SpecRow label="作业数" value={sysInfo.job_count} />
          <SpecRow label="邮件服务" value={sysInfo.email_configured ? '已配置' : '未配置'} />
        </MagSec>
      )}
    </div>
  )
}

export default function AdminSettings() {
  return <AdminGate>{() => <SettingsBody />}</AdminGate>
}
