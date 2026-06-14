import { useEffect, useState, type ReactNode } from 'react'
import { AuthForms, ChangePasswordForm } from './Auth'
import { fetchMe, fetchPublicConfig, getMeCache, getPublicConfigCache, type MeDto } from './api'

/** 下单域门：复用统一登录卡（登录 / 注册 / 忘记密码）。过门后渲染 children；未验证邮箱给横幅提示 */

export function VerifyBanner({ me }: { me: MeDto }) {
  // D17: 仅当实例「要求邮箱验证」时才提示（默认关则不打扰可直接下单的用户）
  const [required, setRequired] = useState<boolean | null>(
    () => getPublicConfigCache()?.require_email_verification ?? null,
  )
  useEffect(() => {
    fetchPublicConfig()
      .then((c) => setRequired(c.require_email_verification))
      .catch(() => {})
  }, [])
  if (me.email_verified || required !== true) return null
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
  if (me.must_change_password) {
    return <ChangePasswordForm onDone={() => setMe({ ...me, must_change_password: false })} />
  }

  return (
    <div>
      <VerifyBanner me={me} />
      {children(me)}
    </div>
  )
}
