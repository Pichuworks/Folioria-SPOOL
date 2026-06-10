import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  changePassword,
  fetchDashboard,
  fetchMe,
  login,
  logout,
  type DashboardDto,
  type MeDto,
} from './api'

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
    <form onSubmit={(e) => void submit(e)} className="mx-auto mt-16 max-w-sm space-y-4 rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
      <h2 className="font-semibold text-lg text-emerald-900">管理域登录</h2>
      <input
        type="email"
        required
        placeholder="email"
        className="w-full rounded-md border border-stone-300 p-2"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        type="password"
        required
        placeholder="password"
        className="w-full rounded-md border border-stone-300 p-2"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button type="submit" className="w-full rounded-md bg-emerald-900 p-2 text-emerald-50">
        登录
      </button>
    </form>
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
    <form onSubmit={(e) => void submit(e)} className="mx-auto mt-16 max-w-sm space-y-4 rounded-lg border border-amber-300 bg-amber-50 p-6">
      <h2 className="font-semibold text-lg text-amber-900">首次登录须修改密码</h2>
      <input
        type="password"
        required
        placeholder="当前密码"
        className="w-full rounded-md border border-stone-300 p-2"
        value={oldPw}
        onChange={(e) => setOldPw(e.target.value)}
      />
      <input
        type="password"
        required
        minLength={8}
        placeholder="新密码（≥8 位）"
        className="w-full rounded-md border border-stone-300 p-2"
        value={newPw}
        onChange={(e) => setNewPw(e.target.value)}
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button type="submit" className="w-full rounded-md bg-amber-700 p-2 text-amber-50">
        修改密码
      </button>
    </form>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 font-medium text-sm text-stone-500">{title}</h3>
      {children}
    </section>
  )
}

export default function Dashboard() {
  const [me, setMe] = useState<MeDto | null | undefined>(undefined)
  const [data, setData] = useState<DashboardDto | null>(null)

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null))
  }, [])

  const reload = useCallback(() => {
    fetchDashboard().then(setData).catch(() => setData(null))
  }, [])

  useEffect(() => {
    if (me && me.role === 'admin' && !me.must_change_password) reload()
  }, [me, reload])

  if (me === undefined) return <p className="p-8 text-stone-500">加载中…</p>
  if (me === null) return <LoginForm onLogin={setMe} />
  if (me.must_change_password) {
    return <ChangePasswordForm onDone={() => setMe({ ...me, must_change_password: false })} />
  }
  if (me.role !== 'admin') {
    return <p className="p-8 text-stone-500">Dashboard 仅管理域可见。</p>
  }
  if (!data) return <p className="p-8 text-stone-500">加载中…</p>

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-semibold text-2xl text-emerald-900">Dashboard</h1>
        <button
          type="button"
          className="text-sm text-stone-500 underline"
          onClick={() => {
            void logout().then(() => setMe(null))
          }}
        >
          {me.name} · 登出
        </button>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title="待办">
          <ul className="space-y-1 text-stone-800">
            <li>进行中作业：{data.todo.jobs_active}</li>
            <li>进行中订单：{data.todo.orders_active}</li>
            <li>维护提醒：{data.todo.maintenance_alerts}</li>
          </ul>
        </Card>

        <Card title="库存预警">
          {data.inventory_alerts.length === 0 ? (
            <p className="text-stone-400">无未解决预警</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.inventory_alerts.map((a) => (
                <li key={a.id} className={a.severity === 'critical' ? 'text-red-700' : 'text-amber-700'}>
                  [{a.severity}] {a.message}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="本月统计">
          <ul className="space-y-1 text-stone-800">
            <li>完成作业：{data.monthly.jobs_done}（{data.monthly.pages} 面）</li>
            <li>收入：{data.monthly.revenue_display}</li>
            <li>
              外部成本：{data.monthly.external_cost_display} · 内部消耗：
              {data.monthly.internal_cost_display}
            </li>
            <li className={data.monthly.profit < 0 ? 'text-red-700' : 'text-emerald-700'}>
              毛利：{data.monthly.profit_display}
            </li>
          </ul>
        </Card>

        <Card title="设备状态">
          <ul className="space-y-1 text-sm text-stone-800">
            {data.equipment.map((p) => (
              <li key={p.code} className="flex justify-between">
                <span>
                  {p.code} <span className="text-stone-400">{p.status}</span>
                </span>
                <span>
                  {p.total_pages}p{p.calibration_due && <span className="ml-2 text-amber-700">需校准</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
