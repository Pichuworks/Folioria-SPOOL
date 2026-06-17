import { type ReactNode } from 'react'
import { AuthForms, ChangePasswordForm } from './Auth'
import { type MeDto } from './api'
import { useAuth } from './AuthContext'

/** 管理域门：复用统一登录卡 → 首登改密 → admin 角色校验。非 admin 仅提示不泄露管理界面 */
export default function AdminGate({ children }: { children: (me: MeDto) => ReactNode }) {
  const me = useAuth()

  if (me === undefined) return <p className="pt-13 text-[14px] text-dim">加载中…</p>
  if (me === null) return <AuthForms onLogin={() => {}} />
  if (me.must_change_password) {
    return <ChangePasswordForm onDone={() => {}} />
  }
  if (me.role !== 'admin') {
    return <p className="pt-13 text-[14px] text-dim">本页仅管理域可见。</p>
  }

  return <div>{children(me)}</div>
}
