import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { fetchMe, getMeCache, login, logout, register, type MeDto } from './api'
import { Field, PillBtn, specInput } from './spec'

/** 下单域统一门：登录 / 注册（R4 开放注册）。过门后渲染 children；未验证邮箱给横幅提示 */

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

const REGISTER_ERROR_TEXT: Record<string, string> = {
  email_exists: '该邮箱已注册，请直接登录。',
  registration_closed: '当前未开放注册，请联系工坊。',
  invalid_invite_code: '邀请码不正确。',
}

function AuthForms({ onLogin }: { onLogin: (me: MeDto) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'login') {
      const me = await login(email, password)
      if (me) onLogin(me)
      else setError('邮箱或密码错误')
    } else {
      const body: { email: string; name: string; password: string; invite_code?: string } = {
        email,
        name,
        password,
      }
      if (inviteCode.trim() !== '') body.invite_code = inviteCode.trim()
      const { me, error: err } = await register(body)
      if (me) onLogin(me)
      else setError(REGISTER_ERROR_TEXT[err ?? ''] ?? '注册失败，请检查邮箱与密码（≥8 位）。')
    }
  }

  const tabClass = (active: boolean) =>
    active
      ? 'border-b-2 border-wine pb-1 text-[14px] font-medium text-wine-ink'
      : 'pb-1 text-[14px] text-dim hover:text-ink'

  const switchMode = (m: 'login' | 'register') => {
    setMode(m)
    setError(null)
  }

  return (
    <AuthCard tag="ATELIER" title={mode === 'login' ? '登录' : '注册账号'}>
      <div className="mb-5 flex gap-6">
        <button type="button" className={tabClass(mode === 'login')} onClick={() => switchMode('login')}>
          登录
        </button>
        <button type="button" className={tabClass(mode === 'register')} onClick={() => switchMode('register')}>
          注册
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="邮箱">
          <input type="email" required className={specInput} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {mode === 'register' && (
          <Field label="称呼">
            <input required maxLength={80} className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <Field label={mode === 'register' ? '密码（≥8 位）' : '密码'}>
          <input
            type="password"
            required
            minLength={mode === 'register' ? 8 : 1}
            className={specInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {mode === 'register' && (
          <Field label="邀请码（未开启可留空）">
            <input className={specInput} value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
          </Field>
        )}
        {error && <p className="text-[13px] text-wine-ink">{error}</p>}
        <PillBtn full>{mode === 'login' ? '登录' : '注册并登录'}</PillBtn>
      </form>
      {mode === 'register' && (
        <p className="mt-4 text-[11.5px] leading-[1.8] text-dim">
          注册后将向邮箱发送验证链接；完成验证方可在线下单。
        </p>
      )}
    </AuthCard>
  )
}

export function VerifyBanner({ me }: { me: MeDto }) {
  if (me.email_verified) return null
  return (
    <div className="mt-5 border border-wine bg-wine-dim/20 px-4 py-3 text-[13px] text-wine-ink">
      邮箱尚未验证——请打开注册邮件中的验证链接后再下单（浏览与报价不受影响）。
    </div>
  )
}

export default function CustomerGate({ children }: { children: (me: MeDto) => ReactNode }) {
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null))
  }, [])

  if (me === undefined) return <p className="pt-13 text-[14px] text-dim">加载中…</p>
  if (me === null) return <AuthForms onLogin={setMe} />

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
          {me.name} · 登出 →
        </button>
      </div>
      <VerifyBanner me={me} />
      {children(me)}
    </div>
  )
}
