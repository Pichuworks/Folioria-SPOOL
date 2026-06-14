import { useEffect, useState, type ReactNode } from 'react'
import { AuthForms, ChangePasswordForm } from './Auth'
import { fetchMe, getMeCache, type MeDto } from './api'

/** 管理域门：复用统一登录卡 → 首登改密 → admin 角色校验。非 admin 仅提示不泄露管理界面 */
export default function AdminGate({ children }: { children: (me: MeDto) => ReactNode }) {
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null))
  }, [])

  if (me === undefined) return <p className="pt-13 text-[14px] text-dim">加载中…</p>
  if (me === null) return <AuthForms onLogin={setMe} />
  if (me.must_change_password) {
    return <ChangePasswordForm onDone={() => setMe({ ...me, must_change_password: false })} />
  }
  if (me.role !== 'admin') {
    return <p className="pt-13 text-[14px] text-dim">本页仅管理域可见。</p>
  }

  return <div>{children(me)}</div>
}
