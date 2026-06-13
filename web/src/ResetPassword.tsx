import { useState, type FormEvent } from 'react'
import { resetPassword } from './api'
import { Field, MagSec, PillBtn, PillLink, specInput } from './spec'

/** D19 #/reset/:token：用一次性 token 设新密码（无效/过期/已用 → 404 提示重新申请） */
export default function ResetPassword({ token }: { token: string }) {
  const [newPw, setNewPw] = useState('')
  const [state, setState] = useState<'form' | 'ok' | 'fail'>('form')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setState((await resetPassword(token, newPw)) ? 'ok' : 'fail')
  }

  return (
    <MagSec tag="重置" title="重置密码" note="PASSWORD RESET">
      {state === 'ok' ? (
        <div>
          <p className="text-[15px] text-ink">密码已重置——所有旧登录已失效，请用新密码登录。</p>
          <div className="mt-5">
            <PillLink href="#/my/orders" kind="primary">去登录 →</PillLink>
          </div>
        </div>
      ) : state === 'fail' ? (
        <div>
          <p className="text-[15px] text-wine-ink">重置链接无效或已过期。</p>
          <p className="mt-2 text-[13px] leading-[1.85] text-dim">
            链接 2 小时内有效且只能使用一次。请重新在登录页点「忘记密码」申请。
          </p>
          <div className="mt-5">
            <PillLink href="#/my/orders" kind="primary">返回登录 →</PillLink>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="mt-2 max-w-sm space-y-4">
          <Field label="新密码（≥8 位）">
            <input
              type="password"
              required
              minLength={8}
              className={specInput}
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
          </Field>
          <PillBtn full>设置新密码</PillBtn>
        </form>
      )}
    </MagSec>
  )
}
