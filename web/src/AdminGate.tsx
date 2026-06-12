import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { changePassword, fetchMe, getMeCache, login, logout, type MeDto } from './api'
import { Field, PillBtn, specInput } from './spec'

function AuthCard({ tag, title, children }: { tag: string; title: string; children: ReactNode }) {
  return (
    <div className="mx-auto mt-16 max-w-sm border border-ink bg-card p-7">
      <div className="mb-5 flex items-center gap-3 border-b border-ink pb-3">
        <span className="bg-ink px-2.5 py-1 font-mono text-[10px] tracking-[.22em] text-paper">{tag}</span>
        <h2 className="text-[20px] font-semibold text-ink">{title}</h2>
      </div>
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
    <AuthCard tag="STAFF" title="管理域登录">
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
    <AuthCard tag="ROTATION" title="首次登录须修改密码">
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

/** 管理域统一门：登录 → 首登改密 → admin 校验，过门后渲染 children 并附登出头 */
export default function AdminGate({ children }: { children: (me: MeDto) => ReactNode }) {
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null))
  }, [])

  if (me === undefined) return <p className="pt-13 text-[14px] text-dim">加载中…</p>
  if (me === null) return <LoginForm onLogin={setMe} />
  if (me.must_change_password) {
    return <ChangePasswordForm onDone={() => setMe({ ...me, must_change_password: false })} />
  }
  if (me.role !== 'admin') {
    return <p className="pt-13 text-[14px] text-dim">本页仅管理域可见。</p>
  }

  return (
    <div>
      <div className="flex justify-end pt-5">
        <button
          type="button"
          className="font-mono text-[10.5px] tracking-[.14em] text-dim hover:text-ink"
          onClick={() => {
            void logout().then(() => setMe(null))
          }}
        >
          CONSOLE · {me.name} · 登出 →
        </button>
      </div>
      {children(me)}
    </div>
  )
}
