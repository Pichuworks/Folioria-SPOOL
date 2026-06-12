import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  changePassword,
  fetchDashboard,
  fetchMe,
  getDashboardCache,
  getMeCache,
  login,
  logout,
  type DashboardDto,
  type MeDto,
} from './api'
import { Field, PillBtn, SpecRow, SpecSec, specInput } from './spec'

function AuthCard({ kicker, title, children }: { kicker: string; title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-16 max-w-sm border border-ink bg-card p-7">
      <div className="mb-1 font-mono text-[10px] tracking-[.3em] text-wine-ink">{kicker}</div>
      <h2 className="mb-5 border-b border-ink pb-3 text-[22px] font-semibold text-ink">{title}</h2>
      {children}
    </div>
  )
}

function LoginForm({ onLogin }: { onLogin: (me: MeDto) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const me = await login(email, password)
    if (me) onLogin(me)
    else setError('邮箱或密码错误')
  }

  return (
    <AuthCard kicker="STAFF ONLY" title="管理域登录">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="邮箱">
          <input type="email" required className={specInput} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="密码">
          <input type="password" required className={specInput} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <p className="text-[13px] text-wine-ink">{error}</p>}
        <PillBtn full>登录</PillBtn>
      </form>
    </AuthCard>
  )
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (await changePassword(oldPw, newPw)) onDone()
    else setError('修改失败：请确认旧密码正确且新密码 ≥ 8 位')
  }

  return (
    <AuthCard kicker="PASSWORD ROTATION" title="首次登录须修改密码">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="当前密码">
          <input type="password" required className={specInput} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
        </Field>
        <Field label="新密码（≥8 位）">
          <input type="password" required minLength={8} className={specInput} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </Field>
        {error && <p className="text-[13px] text-wine-ink">{error}</p>}
        <PillBtn full>修改密码</PillBtn>
      </form>
    </AuthCard>
  )
}

export default function Dashboard() {
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)
  const [data, setData] = useState<DashboardDto | null>(getDashboardCache)

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null))
  }, [])

  const reload = useCallback(() => {
    fetchDashboard().then(setData).catch(() => {
      if (!getDashboardCache()) setData(null)
    })
  }, [])

  useEffect(() => {
    if (me && me.role === 'admin' && !me.must_change_password) reload()
  }, [me, reload])

  if (me === undefined) return <p className="p-10 text-[14px] text-dim">加载中…</p>
  if (me === null) return <LoginForm onLogin={setMe} />
  if (me.must_change_password) {
    return <ChangePasswordForm onDone={() => setMe({ ...me, must_change_password: false })} />
  }
  if (me.role !== 'admin') {
    return <p className="p-10 text-[14px] text-dim">Dashboard 仅管理域可见。</p>
  }
  if (!data) return <p className="p-10 text-[14px] text-dim">加载中…</p>

  return (
    <div className="mx-auto max-w-5xl space-y-10 px-6 py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <div className="mb-2 font-mono text-[10.5px] tracking-[.3em] text-wine-ink">FOLIORIA · S.P.O.O.L. CONSOLE</div>
          <h1 className="text-[36px] font-medium tracking-[.02em] text-ink">Dashboard</h1>
        </div>
        <button
          type="button"
          className="font-mono text-[11px] tracking-[.12em] text-dim hover:text-ink"
          onClick={() => {
            void logout().then(() => setMe(null))
          }}
        >
          {me.name} · 登出 →
        </button>
      </header>

      <div className="grid grid-cols-1 gap-x-12 gap-y-10 md:grid-cols-2">
        <SpecSec n="01" title="待办" note="ACTIVE">
          <SpecRow label="进行中作业" value={data.todo.jobs_active} />
          <SpecRow label="进行中订单" value={data.todo.orders_active} />
          <SpecRow label="维护提醒" value={data.todo.maintenance_alerts} />
        </SpecSec>

        <SpecSec n="02" title="库存预警" note="UNRESOLVED">
          {data.inventory_alerts.length === 0 ? (
            <p className="py-2 text-[13px] text-dim">无未解决预警</p>
          ) : (
            data.inventory_alerts.map((a) => (
              <div key={a.id} className="flex items-baseline gap-3 border-b border-line py-[9px]">
                <span
                  className={`font-mono text-[10px] tracking-[.1em] ${a.severity === 'critical' ? 'text-wine-ink' : 'text-warn'}`}
                >
                  {a.severity.toUpperCase()}
                </span>
                <span className="text-[13px] text-ink">{a.message}</span>
              </div>
            ))
          )}
        </SpecSec>

        <SpecSec n="03" title="本月" note="MONTHLY">
          <SpecRow label="完成作业" note={`${data.monthly.pages} 面`} value={data.monthly.jobs_done} />
          <SpecRow label="收入" value={data.monthly.revenue_display} />
          <SpecRow label="外部成本" value={data.monthly.external_cost_display} />
          <SpecRow label="内部消耗" value={data.monthly.internal_cost_display} />
          <div className="flex items-baseline gap-3.5 py-[11px]">
            <span className="min-w-24 text-[15px] font-medium text-ink">毛利</span>
            <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />
            <span
              className={`font-mono text-[15px] tracking-[.05em] ${data.monthly.profit < 0 ? 'text-warn' : 'text-wine-ink'}`}
            >
              {data.monthly.profit_display}
            </span>
          </div>
        </SpecSec>

        <SpecSec n="04" title="设备" note="FLEET">
          {data.equipment.map((p) => (
            <div key={p.code} className="flex items-baseline gap-3 border-b border-line py-[9px]">
              <span className="min-w-16 text-[14px] font-medium text-ink">{p.code}</span>
              <span className="font-mono text-[10px] tracking-[.1em] text-dim">{p.status.toUpperCase()}</span>
              <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />
              {p.calibration_due && <span className="font-mono text-[10px] tracking-[.1em] text-warn">校准到期</span>}
              <span className="font-mono text-[12px] text-ink">{p.total_pages}P</span>
            </div>
          ))}
        </SpecSec>
      </div>
    </div>
  )
}
