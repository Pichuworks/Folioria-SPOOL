import { useEffect, useRef, useState, type FormEvent } from 'react'
import { changePassword, fetchMe, getMeCache, logout, updateProfile, type MeDto } from './api'
import { Field, MagSec, PillBtn, SpecRow, specInput } from './spec'

/** 刊头右上统一账号控件：guest → 登录/注册；登录态 → 下拉（资料/订单/[管理台]/登出） */
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
          <a href="#/my/orders" className={`${item} text-ink`} onClick={() => setOpen(false)}>
            我的订单
          </a>
          {me.role === 'admin' && (
            <a href="#/dashboard" className={`${item} font-medium text-wine-ink`} onClick={() => setOpen(false)}>
              管理台
            </a>
          )}
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

function AccountBody({ me, onUpdate }: { me: MeDto; onUpdate: (m: MeDto) => void }) {
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
    <div>
      <MagSec tag="01" title="账号" note={me.role.toUpperCase()}>
        <SpecRow label="邮箱" value={me.email} />
        {me.username && <SpecRow label="用户名" value={me.username} />}
        <SpecRow label="邮箱验证" value={me.email_verified ? '已验证' : '未验证'} />
      </MagSec>

      <MagSec tag="02" title="资料">
        <form onSubmit={(e) => void saveProfile(e)} className="max-w-xl space-y-4 border border-ink bg-card p-6">
          <Field label="称呼">
            <input required maxLength={80} className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="联系方式（LINE / 电话等，可留空）">
            <input maxLength={200} className={specInput} value={contact} onChange={(e) => setContact(e.target.value)} />
          </Field>
          <PillBtn full>保存资料</PillBtn>
          {notice && <p className="text-[12.5px] text-wine-ink">{notice}</p>}
        </form>
      </MagSec>

      <MagSec tag="03" title="修改密码">
        <form onSubmit={(e) => void changePw(e)} className="max-w-xl space-y-4 border border-ink bg-card p-6">
          <Field label="当前密码">
            <input type="password" required className={specInput} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          </Field>
          <Field label="新密码（≥8 位）">
            <input type="password" required minLength={8} className={specInput} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </Field>
          <PillBtn full>修改密码</PillBtn>
          {pwMsg && <p className="text-[12.5px] text-wine-ink">{pwMsg}</p>}
        </form>
      </MagSec>
    </div>
  )
}

export default function Account() {
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)
  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null))
  }, [])

  if (me === undefined) return <p className="pt-13 text-[14px] text-dim">加载中…</p>
  if (me === null) {
    return (
      <MagSec tag="账号" title="账号设置" note="ACCOUNT">
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
  return <AccountBody me={me} onUpdate={setMe} />
}
