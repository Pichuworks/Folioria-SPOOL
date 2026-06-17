import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  changePassword,
  fetchNotifyPrefs,
  logout,
  updateNotifyPrefs,
  updateProfile,
  type MeDto,
  type NotifyPrefsDto,
} from './api'
import { useAuth } from './AuthContext'
import { Field, MagSec, PillBtn, SpecRow, TabBar, specInput, toast } from './spec'

/** C3 通知偏好（目前仅 email channel） */
function NotifyPrefsSection() {
  const [prefs, setPrefs] = useState<NotifyPrefsDto | null>(null)
  const [emailOn, setEmailOn] = useState(true)
  const [altEmail, setAltEmail] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchNotifyPrefs().then((r) => {
      if (r.ok && !cancelled) {
        setPrefs(r.data)
        setEmailOn(r.data.channels.includes('email'))
        setAltEmail(r.data.addresses.email ?? '')
      }
    })
    return () => { cancelled = true }
  }, [])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const r = await updateNotifyPrefs({
      channels: emailOn ? ['email'] : [],
      addresses: { email: altEmail.trim() === '' ? null : altEmail.trim() },
    })
    if (r.ok) {
      setPrefs(r.data)
      setMsg('通知偏好已保存')
      toast('通知偏好已保存', 'ok')
    } else setMsg((r.data as { error?: string })?.error === 'invalid_email' ? '通知邮箱格式不正确' : '保存失败')
  }

  if (!prefs) return null
  return (
    <form onSubmit={(e) => void save(e)} className="mt-6 max-w-xl space-y-4 border border-ink bg-card p-6">
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={emailOn} onChange={(e) => setEmailOn(e.target.checked)} />
        接收邮件通知
      </label>
      <Field label={`通知邮箱（留空 = 账号邮箱 ${prefs.account_email}）`}>
        <input
          type="email"
          disabled={!emailOn}
          className={specInput}
          value={altEmail}
          onChange={(e) => setAltEmail(e.target.value)}
        />
      </Field>
      <PillBtn full>保存通知偏好</PillBtn>
      {msg && <p className="text-[12.5px] text-wine-ink">{msg}</p>}
    </form>
  )
}

export function DashboardPill({ admin, active }: { admin: boolean; active: boolean }) {
  return (
    <a
      href="#/dashboard"
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-[14px] py-1.5 text-[12px] font-medium tracking-[.02em] transition-opacity hover:opacity-90 ${
        active ? 'border-wine bg-wine text-cream' : 'border-wine text-wine-ink'
      }`}
    >
      {admin ? '管理台' : '面板'}
    </a>
  )
}

export function AccountMenu({ me }: { me: MeDto | null }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  if (!me) {
    return (
      <a href="#/login" className="whitespace-nowrap font-medium text-wine-ink hover:opacity-80">
        登录 / 注册
      </a>
    )
  }
  const item = 'block w-full px-4 py-2.5 text-left text-[13px] hover:bg-wine-dim/30'
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="whitespace-nowrap text-dim hover:text-ink">
        {me.name} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-40 border border-ink bg-card shadow-e1">
          <a href="#/account" className={`${item} text-ink`} onClick={() => setOpen(false)}>
            账号设置
          </a>
          <button
            type="button"
            className={`${item} text-dim`}
            onClick={() => {
              setOpen(false)
              void logout()
            }}
          >
            登出
          </button>
        </div>
      )}
    </div>
  )
}

const ACCOUNT_TABS = [
  { key: 'info', label: '账号' },
  { key: 'profile', label: '资料' },
  { key: 'password', label: '密码' },
  { key: 'notify', label: '通知' },
] as const
type AccountTab = (typeof ACCOUNT_TABS)[number]['key']

function AccountBody({ me, onUpdate }: { me: MeDto; onUpdate: (m: MeDto) => void }) {
  const [tab, setTab] = useState<AccountTab>('info')
  const [name, setName] = useState(me.name)
  const [contact, setContact] = useState(me.contact_info ?? '')
  const [notice, setNotice] = useState<string | null>(null)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwMsg, setPwMsg] = useState<string | null>(null)

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault()
    const updated = await updateProfile({ name, contact_info: contact.trim() === '' ? null : contact.trim() })
    if (updated) {
      onUpdate(updated)
      setNotice('资料已保存')
    } else setNotice('保存失败')
  }

  const changePw = async (e: FormEvent) => {
    e.preventDefault()
    if (await changePassword(oldPw, newPw)) {
      setOldPw('')
      setNewPw('')
      setPwMsg('密码已修改——其它设备的登录已失效')
    } else setPwMsg('修改失败：请确认旧密码正确且新密码 ≥ 8 位')
  }

  return (
    <MagSec title="账号设置" note={me.role.toUpperCase()}>
      <TabBar tabs={[...ACCOUNT_TABS]} active={tab} onChange={(k) => setTab(k as AccountTab)} />

      {tab === 'info' && (
        <div className="pt-6">
          <SpecRow label="邮箱" value={me.email} />
          {me.username && <SpecRow label="用户名" value={me.username} />}
          <SpecRow label="邮箱验证" value={me.email_verified ? '已验证' : '未验证'} />
        </div>
      )}

      {tab === 'profile' && (
        <form onSubmit={(e) => void saveProfile(e)} className="mt-6 max-w-xl space-y-4 border border-ink bg-card p-6">
          <Field label="称呼">
            <input required maxLength={80} className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="联系方式">
            <input maxLength={200} className={specInput} value={contact} onChange={(e) => setContact(e.target.value)} />
          </Field>
          <PillBtn full>保存资料</PillBtn>
          {notice && <p className="text-[12.5px] text-wine-ink">{notice}</p>}
        </form>
      )}

      {tab === 'password' && (
        <form onSubmit={(e) => void changePw(e)} className="mt-6 max-w-xl space-y-4 border border-ink bg-card p-6">
          <Field label="当前密码">
            <input type="password" required className={specInput} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          </Field>
          <Field label="新密码">
            <input type="password" required minLength={8} className={specInput} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </Field>
          <PillBtn full>修改密码</PillBtn>
          {pwMsg && <p className="text-[12.5px] text-wine-ink">{pwMsg}</p>}
        </form>
      )}

      {tab === 'notify' && <NotifyPrefsSection />}
    </MagSec>
  )
}

export default function Account() {
  const me = useAuth()

  if (me === undefined) return <p className="pt-13 text-[14px] text-dim">加载中…</p>
  if (me === null) {
    return (
      <MagSec title="账号设置">
        <p className="text-[14px] text-dim">
          请先{' '}
          <a href="#/login" className="text-wine-ink hover:opacity-70">
            登录
          </a>
          。
        </p>
      </MagSec>
    )
  }
  return <AccountBody me={me} onUpdate={() => {}} />
}
