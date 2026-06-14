import { useCallback, useEffect, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { ORDER_STATUS_LABEL, send, type OrderDto } from './api'
import { Field, Leader, MagSec, PillBtn, SpecRow, specInput } from './spec'

interface UserDto {
  id: string
  email: string
  name: string
  role: 'customer' | 'member' | 'admin'
  archived: boolean
  created_at: string
}

interface CustomerSummary {
  user: { id: string; email: string; username: string | null; name: string; role: string; contact_info: string | null; created_at: string }
  stats: {
    order_count: number
    active_count: number
    total_paid: number
    total_paid_display: string
    outstanding: number
    outstanding_display: string
  }
  orders: Array<{
    id: string
    order_number: string
    status: OrderDto['status']
    total: number
    total_display: string
    paid_amount: number
    paid_amount_display: string
    created_at: string
  }>
}

const ROLE_LABEL: Record<UserDto['role'], string> = {
  customer: '顾客',
  member: '内部成员',
  admin: '管理员',
}

function Drilldown({ userId }: { userId: string }) {
  const [data, setData] = useState<CustomerSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void send<CustomerSummary>('GET', `/api/admin/users/${userId}/summary`).then((r) => {
      if (r.ok) setData(r.data)
      else setErr('加载失败')
    })
  }, [userId])

  if (err) return <p className="mt-2 text-[12px] text-wine-ink">{err}</p>
  if (!data) return <p className="mt-2 text-[12px] text-dim">钻取中…</p>

  return (
    <div className="mt-2 border border-line bg-card p-4">
      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <SpecRow label="累计已收" strong value={data.stats.total_paid_display} />
          <SpecRow label="欠款" value={data.stats.outstanding_display} />
          <SpecRow label="订单数" note={`活跃 ${data.stats.active_count}`} value={String(data.stats.order_count)} />
          {data.user.contact_info && <SpecRow label="联系方式" value={data.user.contact_info} />}
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] tracking-[.14em] text-dim">订单史 · {data.orders.length}</div>
          {data.orders.length === 0 && <p className="text-[12px] text-dim">暂无订单。</p>}
          {data.orders.map((o) => (
            <div key={o.id} className="flex items-baseline gap-2 border-b border-line py-[5px] text-[12px]">
              <a href={`#/admin/orders`} className="font-mono text-ink hover:text-wine-ink">{o.order_number}</a>
              <span className="font-mono text-[10.5px] tracking-[.1em] text-dim">{ORDER_STATUS_LABEL[o.status]}</span>
              <span className="text-[10.5px] text-dim">{o.created_at.slice(0, 10)}</span>
              <Leader />
              <span className="font-mono text-dim">{o.paid_amount_display}/{o.total_display}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function UserRow({ user, onChanged }: { user: UserDto; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const patch = async (body: { role?: string; archived?: boolean }) => {
    const res = await send<{ error?: string }>('PATCH', `/api/admin/users/${user.id}`, body)
    if (res.ok) onChanged()
    else setError(res.data.error === 'last_admin' ? '最后一个活跃管理员，禁止降格/归档' : '操作失败')
  }

  return (
    <div className="border-b border-line py-[8px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-[14px] font-medium ${user.archived ? 'text-dim line-through' : 'text-ink'}`}>
          {user.name}
        </span>
        <span className="text-[12px] text-dim">{user.email}</span>
        <span className="font-mono text-[10px] tracking-[.08em] text-dim">{user.created_at.slice(0, 10)}</span>
        <Leader />
        <button
          type="button"
          className="font-mono text-[10px] tracking-[.14em] text-wine-ink hover:opacity-70"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : '钻取'}
        </button>
        <select
          className="border border-line bg-card px-2 py-1 font-mono text-[11px] text-ink outline-none"
          value={user.role}
          disabled={user.archived}
          onChange={(e) => void patch({ role: e.target.value })}
        >
          {Object.entries(ROLE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <button
          type="button"
          className="font-mono text-[10px] tracking-[.14em] text-dim hover:opacity-70"
          onClick={() => {
            if (user.archived || window.confirm(`归档「${user.name}」？其登录将被拒绝。`)) {
              void patch({ archived: !user.archived })
            }
          }}
        >
          {user.archived ? '恢复' : '归档'}
        </button>
      </div>
      {open && <Drilldown userId={user.id} />}
      {error && <p className="mt-1 text-[12px] text-wine-ink">{error}</p>}
    </div>
  )
}

function UsersBody() {
  const [users, setUsers] = useState<UserDto[] | null>(null)
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'member' })
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(() => {
    void send<UserDto[]>('GET', '/api/admin/users').then((r) => r.ok && setUsers(r.data))
  }, [])
  useEffect(reload, [reload])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const res = await send<{ error?: string }>('POST', '/api/admin/users', form)
    if (res.ok) {
      setForm({ email: '', name: '', password: '', role: 'member' })
      setNotice('已创建——初始密码首登强制更换')
      reload()
    } else {
      setNotice(res.data.error === 'email_exists' ? '该邮箱已注册' : '创建失败（密码 ≥ 8 位）')
    }
  }

  if (!users) return <p className="pt-13 text-[14px] text-dim">用户加载中…</p>

  return (
    <div>
      <MagSec tag="01" title="账号名册" note={`${users.length} ACCOUNTS · B1 双域`}>
        {users.map((u) => (
          <UserRow key={u.id} user={u} onChanged={reload} />
        ))}
      </MagSec>

      <MagSec tag="02" title="添加账号" note="ADMIN PROVISION ONLY">
        <form onSubmit={(e) => void submit(e)} className="flex max-w-xl flex-col gap-4 border border-ink bg-card p-6">
          <Field label="邮箱">
            <input
              type="email"
              required
              className={specInput}
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </Field>
          <Field label="姓名">
            <input
              type="text"
              required
              className={specInput}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label="初始密码（≥8 位，对方首登须更换）">
            <input
              type="text"
              required
              minLength={8}
              className={specInput}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </Field>
          <Field label="角色">
            <select
              className={specInput}
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            >
              {Object.entries(ROLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>
          <PillBtn full>创建账号</PillBtn>
          {notice && <p className="text-[12.5px] text-wine-ink">{notice}</p>}
        </form>
      </MagSec>
    </div>
  )
}

export default function AdminUsers() {
  return <AdminGate>{() => <UsersBody />}</AdminGate>
}
