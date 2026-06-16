import { useState, type FormEvent, type ReactNode } from 'react'
import { changePassword, forgotPassword, login, register, type MeDto } from './api'
import { Field, PillBtn, specInput } from './spec'

/** 共享登录卡：两域（下单 / 管理）统一入口，不再做品牌化区分 */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto mt-16 max-w-sm border border-ink bg-card p-7">
      <div className="mb-5 border-b border-ink pb-3">
        <h2 className="text-[20px] font-semibold text-ink">{title}</h2>
      </div>
      {children}
    </div>
  )
}

const REGISTER_ERROR_TEXT: Record<string, string> = {
  email_exists: '该邮箱已注册，请直接登录。',
  username_taken: '该用户名已被占用，请换一个。',
  registration_closed: '当前未开放注册，请联系工坊。',
  invalid_invite_code: '邀请码不正确。',
}

/** 统一登录表单：登录 / 注册 / 忘记密码 同一卡片，两域共用 */
export function AuthForms({ onLogin }: { onLogin: (me: MeDto) => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [forgotSent, setForgotSent] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'forgot') {
      await forgotPassword(email) // email 字段此态即标识符
      setForgotSent(true)
      return
    }
    if (mode === 'login') {
      // email 字段在登录态即「用户名或邮箱」标识符
      const me = await login(email, password)
      if (me) onLogin(me)
      else setError('用户名/邮箱或密码错误')
    } else {
      const body: { email: string; username?: string; name: string; password: string; invite_code?: string } = {
        email,
        name,
        password,
      }
      if (username.trim() !== '') body.username = username.trim()
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

  const switchMode = (m: 'login' | 'register' | 'forgot') => {
    setMode(m)
    setError(null)
    setForgotSent(false)
  }

  if (mode === 'forgot') {
    return (
      <AuthCard title="重置密码">
        {forgotSent ? (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.85] text-ink">
              若该用户名/邮箱对应的账号存在，重置链接已发送至其邮箱。请在 2 小时内打开链接设置新密码。
            </p>
            <button type="button" className="text-[12.5px] text-dim hover:text-ink" onClick={() => switchMode('login')}>
              ← 返回登录
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="space-y-4">
            <Field label="用户名或邮箱">
              <input type="text" required className={specInput} value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <PillBtn full>发送重置链接</PillBtn>
            <button type="button" className="text-[12.5px] text-dim hover:text-ink" onClick={() => switchMode('login')}>
              ← 返回登录
            </button>
          </form>
        )}
      </AuthCard>
    )
  }

  return (
    <AuthCard title={mode === 'login' ? '登录' : '注册账号'}>
      <div className="mb-5 flex gap-6">
        <button type="button" className={tabClass(mode === 'login')} onClick={() => switchMode('login')}>
          登录
        </button>
        <button type="button" className={tabClass(mode === 'register')} onClick={() => switchMode('register')}>
          注册
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label={mode === 'login' ? '用户名或邮箱' : '邮箱'}>
          <input
            type={mode === 'login' ? 'text' : 'email'}
            required
            className={specInput}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        {mode === 'register' && (
          <>
            <Field label="用户名（可选，3–30 位小写字母/数字/下划线）">
              <input
                className={specInput}
                value={username}
                pattern="[a-z0-9_]{3,30}"
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field label="称呼">
              <input required maxLength={80} className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </>
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
      {mode === 'login' && (
        <button
          type="button"
          className="mt-4 text-[12.5px] text-dim hover:text-ink"
          onClick={() => switchMode('forgot')}
        >
          忘记密码？
        </button>
      )}
      {mode === 'register' && (
        <p className="mt-4 text-[11.5px] leading-[1.8] text-dim">
          注册后将向邮箱发送验证链接；完成验证方可在线下单。
        </p>
      )}
    </AuthCard>
  )
}

/** 首登强制改密（D11）：admin 供给的账号也走此门，必须能在此清标志 */
export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (await changePassword(oldPw, newPw)) onDone()
    else setError('修改失败：请确认旧密码正确且新密码 ≥ 8 位')
  }

  return (
    <AuthCard title="首次登录须修改密码">
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
