import { useEffect, useState, type ReactNode } from 'react'
import { AuthForms, ChangePasswordForm } from './Auth'
import { fetchPublicConfig, getPublicConfigCache, type MeDto } from './api'
import { useAuth } from './AuthContext'

/** 下单域门：复用统一登录卡（登录 / 注册 / 忘记密码）。过门后渲染 children；未验证邮箱给横幅提示 */

export function VerifyBanner({ me }: { me: MeDto }) {
  const [required, setRequired] = useState<boolean | null>(
    () => getPublicConfigCache()?.require_email_verification ?? null,
  )
  useEffect(() => {
    let cancelled = false
    fetchPublicConfig()
      .then((c) => { if (!cancelled) setRequired(c.require_email_verification) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  if (me.email_verified || required !== true) return null
  return (
    <div className="mt-5 border border-wine bg-wine-dim/20 px-4 py-3 text-[13px] text-wine-ink">
      邮箱尚未验证——请打开注册邮件中的验证链接后再下单（浏览与报价不受影响）。
    </div>
  )
}

export default function CustomerGate({ children }: { children: (me: MeDto) => ReactNode }) {
  const me = useAuth()

  if (me === undefined) return <p className="pt-13 text-[14px] text-dim">加载中…</p>
  if (me === null) return <AuthForms onLogin={() => {}} />
  if (me.must_change_password) {
    return <ChangePasswordForm onDone={() => {}} />
  }

  return (
    <div>
      <VerifyBanner me={me} />
      {children(me)}
    </div>
  )
}
