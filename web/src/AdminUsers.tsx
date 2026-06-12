import { useCallback, useEffect, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Field, Leader, MagSec, PillBtn, specInput } from './spec'

interface UserDto {
  id: string
  email: string
  name: string
  role: 'customer' | 'member' | 'admin'
  archived: boolean
  created_at: string
}

const ROLE_LABEL: Record<UserDto['role'], string> = {
  customer: '顾客',
  member: '内部成员',
  admin: '管理员',
}

function UserRow({ user, onChanged }: { user: UserDto; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null)

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
