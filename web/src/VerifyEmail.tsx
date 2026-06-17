import { useEffect, useRef, useState } from 'react'
import { verifyEmailToken } from './api'
import { useAuth } from './AuthContext'
import { MagSec, PillLink } from './spec'

/** R4 #/verify/:token：消费邮箱验证 token（一次性；无效/过期/复用 → 404） */
export default function VerifyEmail({ token }: { token: string }) {
  const me = useAuth()
  const [state, setState] = useState<'pending' | 'ok' | 'fail'>('pending')
  const fired = useRef<string | null>(null)

  useEffect(() => {
    if (fired.current === token) return
    fired.current = token
    let cancelled = false
    void verifyEmailToken(token).then((ok) => {
      if (cancelled) return
      if (ok) return setState('ok')
      setState(me?.email_verified ? 'ok' : 'fail')
    })
    return () => { cancelled = true }
  }, [token, me])

  return (
    <MagSec title="邮箱验证">
      {state === 'pending' ? (
        <p className="text-[14px] text-dim">验证中…</p>
      ) : state === 'ok' ? (
        <div>
          <p className="text-[15px] text-ink">邮箱验证完成，现在可以在线下单了。</p>
          <div className="mt-5 flex gap-3">
            <PillLink href="#/quote" kind="primary">去下单 →</PillLink>
            <PillLink href="#/my/orders" kind="ghost">我的订单</PillLink>
          </div>
        </div>
      ) : (
        <div>
          <p className="text-[15px] text-wine-ink">验证链接无效或已过期。</p>
          <p className="mt-2 text-[13px] leading-[1.85] text-dim">
            链接 48 小时内有效且只能使用一次。若已验证过，直接登录下单即可；否则请重新注册或联系工坊。
          </p>
          <div className="mt-5">
            <PillLink href="#/my/orders" kind="primary">去登录 →</PillLink>
          </div>
        </div>
      )}
    </MagSec>
  )
}
