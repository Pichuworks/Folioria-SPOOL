import { useState, type FormEvent } from 'react'
import { setupInstance, type MeDto } from './api'
import { Field, MagSec, PillBtn, specInput } from './spec'

const SETUP_ERROR: Record<string, string> = {
  already_initialized: '实例已初始化，请直接登录。',
  unknown_currency: '未知货币代码。',
  invalid_email: '管理员邮箱格式不正确。',
  weak_password: '密码至少 8 位。',
}

/** 首次运行（无 system_config）时的 Web 初始化向导 */
export default function Setup({ onDone }: { onDone: (me: MeDto) => void }) {
  const [baseCurrency, setBaseCurrency] = useState('JPY')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [seed, setSeed] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    const { me, error: err } = await setupInstance({
      base_currency: baseCurrency,
      admin_email: email,
      admin_name: name,
      admin_password: password,
      seed,
    })
    setBusy(false)
    if (me) onDone(me)
    else setError(SETUP_ERROR[err ?? ''] ?? '初始化失败，请检查输入。')
  }

  return (
    <MagSec tag="初始化" title="实例初始化" note="FIRST RUN">
      <p className="mb-5 max-w-xl text-[13px] leading-[1.85] text-dim">
        欢迎使用 S.P.O.O.L.。请设定实例基准货币并创建首位管理员。基准货币在产生业务数据后将锁定（换币种 = 新实例）。
      </p>
      <form onSubmit={(e) => void submit(e)} className="max-w-xl space-y-4 border border-ink bg-card p-6">
        <Field label="基准货币（锁定后不可改）">
          <select className={specInput} value={baseCurrency} onChange={(e) => setBaseCurrency(e.target.value)}>
            <option value="JPY">JPY · 日元 ¥</option>
            <option value="CNY">CNY · 人民币 ￥</option>
            <option value="USD">USD · 美元 $</option>
          </select>
        </Field>
        <Field label="管理员邮箱">
          <input type="email" required className={specInput} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="管理员称呼">
          <input required maxLength={80} className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="管理员密码（≥8 位）">
          <input
            type="password"
            required
            minLength={8}
            className={specInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="确认密码">
          <input
            type="password"
            required
            minLength={8}
            className={specInput}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={seed} onChange={(e) => setSeed(e.target.checked)} />
          导入示例目录（打印机 / 纸张 / 模式 / 定价 seed，便于快速试用）
        </label>
        {error && <p className="text-[13px] text-wine-ink">{error}</p>}
        <PillBtn full>{busy ? '初始化中…' : '初始化实例 →'}</PillBtn>
      </form>
    </MagSec>
  )
}
