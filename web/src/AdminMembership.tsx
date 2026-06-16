import { useEffect, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import { Btn, Field, MagSec, PillBtn, Skeleton, specInput, TabBar } from './spec'

interface Criterion {
  id?: number
  tier_id?: number
  dimension: string
  op: string
  threshold: number
}

interface Tier {
  id: number
  track: string
  code: string
  name: string
  sort: number
  discount_bp: number
  auto_upgrade: boolean
  color_tag: string | null
  description: string | null
  archived: boolean
  created_at: string
  criteria: Criterion[]
}

interface MemberUser {
  user_id: string
  track: string
  tier_id: number
  assigned_at: string
  assigned_by: string | null
  manual: boolean
  expires_at: string | null
  user_name: string
  user_email: string
  tier_code: string
  tier_name: string
  discount_bp: number
}

interface UserOption {
  id: string
  name: string
  email: string
}

const TABS = [
  { key: 'tiers', label: '等级定义' },
  { key: 'members', label: '会员管理' },
] as const
type TabKey = (typeof TABS)[number]['key']

const DIMENSION_LABELS: Record<string, string> = {
  order_count: '累计订单数',
  order_amount: '累计消费金额',
}

const OP_LABELS: Record<string, string> = {
  gte: '≥',
  lte: '≤',
  eq: '=',
}

function TierForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Tier
  onSave: () => void
  onCancel: () => void
}) {
  const [form, setForm] = useState({
    track: initial?.track ?? 'default',
    code: initial?.code ?? '',
    name: initial?.name ?? '',
    sort: initial?.sort ?? 0,
    discount_bp: initial?.discount_bp ?? 0,
    auto_upgrade: initial?.auto_upgrade ?? false,
    color_tag: initial?.color_tag ?? '',
    description: initial?.description ?? '',
  })
  const [criteria, setCriteria] = useState<Criterion[]>(
    initial?.criteria ?? [],
  )
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const body = {
      ...form,
      color_tag: form.color_tag || null,
      description: form.description || null,
    }
    const res = initial
      ? await send<Tier>('PATCH', `/api/admin/membership/tiers/${initial.id}`, body)
      : await send<Tier>('POST', '/api/admin/membership/tiers', body)
    if (!res.ok) {
      setError((res.data as { error?: string }).error ?? '保存失败')
      return
    }
    if (initial) {
      await send('PUT', `/api/admin/membership/tiers/${initial.id}/criteria`, { criteria })
    } else {
      await send('PUT', `/api/admin/membership/tiers/${res.data.id}/criteria`, { criteria })
    }
    onSave()
  }

  const addCriterion = () =>
    setCriteria([...criteria, { dimension: 'order_count', op: 'gte', threshold: 0 }])
  const removeCriterion = (i: number) =>
    setCriteria(criteria.filter((_, idx) => idx !== i))
  const updateCriterion = (i: number, patch: Partial<Criterion>) =>
    setCriteria(criteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))

  const f = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value })

  return (
    <form onSubmit={submit} className="space-y-4 border border-ink bg-paper p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="编码">
          <input className={specInput} value={form.code} onChange={f('code')} required />
        </Field>
        <Field label="名称">
          <input className={specInput} value={form.name} onChange={f('name')} required />
        </Field>
        <Field label="轨道">
          <input className={specInput} value={form.track} onChange={f('track')} />
        </Field>
        <Field label="排序权重">
          <input className={specInput} type="number" value={form.sort} onChange={(e) => setForm({ ...form, sort: Number(e.target.value) })} />
        </Field>
        <Field label="折扣 (基点)">
          <input className={specInput} type="number" min={0} max={10000} value={form.discount_bp} onChange={(e) => setForm({ ...form, discount_bp: Number(e.target.value) })} />
          <span className="ml-2 text-xs text-dim">{(form.discount_bp / 100).toFixed(2)}%</span>
        </Field>
        <Field label="色标">
          <input className={specInput} value={form.color_tag} onChange={f('color_tag')} placeholder="可选" />
        </Field>
      </div>
      <Field label="描述">
        <input className={specInput} value={form.description} onChange={f('description')} placeholder="可选" />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.auto_upgrade} onChange={(e) => setForm({ ...form, auto_upgrade: e.target.checked })} />
        自动升级（满足条件后系统自动指派）
      </label>

      <MagSec title="升级条件" note={criteria.length === 0 ? '无条件 = 纯手动指派' : `${criteria.length} 条 (AND)`}><div /></MagSec>
      {criteria.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className={specInput + ' w-40'}
            value={c.dimension}
            onChange={(e) => updateCriterion(i, { dimension: e.target.value })}
            list="dim-options"
            placeholder="维度"
          />
          <select
            className={specInput + ' w-16'}
            value={c.op}
            onChange={(e) => updateCriterion(i, { op: e.target.value })}
          >
            {Object.entries(OP_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <input
            className={specInput + ' w-28'}
            type="number"
            value={c.threshold}
            onChange={(e) => updateCriterion(i, { threshold: Number(e.target.value) })}
          />
          <button type="button" onClick={() => removeCriterion(i)} className="text-xs text-dim hover:text-ink">
            ✕
          </button>
        </div>
      ))}
      <datalist id="dim-options">
        {Object.keys(DIMENSION_LABELS).map((d) => (
          <option key={d} value={d}>{DIMENSION_LABELS[d]}</option>
        ))}
      </datalist>
      <button type="button" onClick={addCriterion} className="text-xs text-dim hover:text-ink">
        + 添加条件
      </button>

      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-3 pt-2">
        <PillBtn type="submit">{initial ? '保存' : '创建'}</PillBtn>
        <PillBtn type="button" onClick={onCancel}>取消</PillBtn>
      </div>
    </form>
  )
}

function TiersTab() {
  const [tiers, setTiers] = useState<Tier[] | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)

  const load = () =>
    void send<Tier[]>('GET', '/api/admin/membership/tiers').then((r) => r.ok && setTiers(r.data))
  useEffect(load, [])

  if (!tiers) return <Skeleton />

  const grouped = new Map<string, Tier[]>()
  for (const t of tiers) {
    const arr = grouped.get(t.track) ?? []
    arr.push(t)
    grouped.set(t.track, arr)
  }

  return (
    <div className="space-y-6 pt-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-dim">{tiers.length} 个等级</span>
        <Btn variant="outline" size="sm" onClick={() => setEditing('new')}>新建等级</Btn>
      </div>

      {editing === 'new' && (
        <TierForm onSave={() => { setEditing(null); load() }} onCancel={() => setEditing(null)} />
      )}

      {[...grouped.entries()].map(([track, items]) => (
        <div key={track}>
          <MagSec title={`轨道: ${track}`} note={`${items.length} 个等级`}><div /></MagSec>
          <div className="space-y-3">
            {items.map((t) =>
              editing === t.id ? (
                <TierForm key={t.id} initial={t} onSave={() => { setEditing(null); load() }} onCancel={() => setEditing(null)} />
              ) : (
                <div key={t.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line py-3 text-sm">
                  <span className="font-mono font-bold">{t.code}</span>
                  <span>{t.name}</span>
                  {t.color_tag && (
                    <span className="rounded-sm bg-line/40 px-1.5 py-0.5 text-xs">{t.color_tag}</span>
                  )}
                  <span className="text-dim">排序 {t.sort}</span>
                  <span className="text-dim">折扣 {(t.discount_bp / 100).toFixed(2)}%</span>
                  {t.auto_upgrade && <span className="text-xs text-green-700">自动升级</span>}
                  {t.archived && <span className="text-xs text-red-600">已归档</span>}
                  {t.criteria.length > 0 && (
                    <span className="text-xs text-dim">
                      条件: {t.criteria.map((c) => `${DIMENSION_LABELS[c.dimension] ?? c.dimension} ${OP_LABELS[c.op] ?? c.op} ${c.threshold}`).join(' & ')}
                    </span>
                  )}
                  <button onClick={() => setEditing(t.id)} className="ml-auto text-xs text-dim hover:text-ink">
                    编辑
                  </button>
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function MembersTab() {
  const [members, setMembers] = useState<MemberUser[] | null>(null)
  const [tiers, setTiers] = useState<Tier[] | null>(null)
  const [users, setUsers] = useState<UserOption[] | null>(null)
  const [assignForm, setAssignForm] = useState(false)
  const [selUsers, setSelUsers] = useState<Set<string>>(new Set())
  const [selTier, setSelTier] = useState<number | ''>('')
  const [assignErr, setAssignErr] = useState<string | null>(null)
  const [userFilter, setUserFilter] = useState('')

  const load = () => {
    void send<MemberUser[]>('GET', '/api/admin/membership/users').then((r) => r.ok && setMembers(r.data))
    void send<Tier[]>('GET', '/api/admin/membership/tiers').then((r) => r.ok && setTiers(r.data))
  }
  useEffect(() => {
    load()
    void send<UserOption[]>('GET', '/api/admin/users').then((r) => r.ok && setUsers(r.data))
  }, [])

  const toggleUser = (id: string) => {
    setSelUsers((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const assign = async (e: FormEvent) => {
    e.preventDefault()
    setAssignErr(null)
    if (selUsers.size === 0 || selTier === '') return
    const ids = [...selUsers]
    const res = ids.length === 1
      ? await send('POST', '/api/admin/membership/assign', { user_id: ids[0], tier_id: selTier })
      : await send('POST', '/api/admin/membership/batch-assign', { user_ids: ids, tier_id: selTier })
    if (!res.ok) {
      setAssignErr((res.data as { error?: string }).error ?? '指派失败')
      return
    }
    setAssignForm(false)
    setSelUsers(new Set())
    setSelTier('')
    setUserFilter('')
    load()
  }

  const remove = async (userId: string, track: string) => {
    await send('POST', '/api/admin/membership/remove', { user_id: userId, track })
    load()
  }

  if (!members || !tiers) return <Skeleton />

  const activeTiers = tiers.filter((t) => !t.archived)
  const filterLc = userFilter.toLowerCase()
  const filteredUsers = users?.filter(
    (u) => !filterLc || u.name.toLowerCase().includes(filterLc) || u.email.toLowerCase().includes(filterLc),
  )

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-dim">{members.length} 条绑定</span>
        <Btn variant="outline" size="sm" onClick={() => setAssignForm(!assignForm)}>指派会员</Btn>
      </div>

      {assignForm && (
        <form onSubmit={assign} className="space-y-3 border border-ink p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="等级">
              <select className={specInput} value={selTier} onChange={(e) => setSelTier(Number(e.target.value))} required>
                <option value="">选择等级…</option>
                {activeTiers.map((t) => (
                  <option key={t.id} value={t.id}>[{t.track}] {t.code} · {t.name}</option>
                ))}
              </select>
            </Field>
            <Btn type="submit" disabled={selUsers.size === 0}>
              确认{selUsers.size > 0 ? ` (${selUsers.size})` : ''}
            </Btn>
            {assignErr && <span className="text-xs text-red-600">{assignErr}</span>}
          </div>
          <Field label={`用户 (已选 ${selUsers.size})`}>
            <input
              className={specInput}
              placeholder="搜索用户…"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
            />
          </Field>
          <div className="max-h-48 overflow-y-auto border border-line">
            {filteredUsers?.map((u) => (
              <label
                key={u.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-line/30"
              >
                <input
                  type="checkbox"
                  checked={selUsers.has(u.id)}
                  onChange={() => toggleUser(u.id)}
                />
                <span>{u.name}</span>
                <span className="text-dim">{u.email}</span>
              </label>
            ))}
            {filteredUsers?.length === 0 && (
              <p className="py-2 text-center text-xs text-dim">无匹配用户</p>
            )}
          </div>
        </form>
      )}

      <div className="space-y-1">
        {members.map((m) => (
          <div key={`${m.user_id}-${m.track}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-2 text-sm">
            <span className="font-bold">{m.user_name}</span>
            <span className="text-dim">{m.user_email}</span>
            <span className="font-mono">{m.tier_code}</span>
            <span>{m.tier_name}</span>
            <span className="text-dim">({m.track})</span>
            <span className="text-xs text-dim">{(m.discount_bp / 100).toFixed(2)}%</span>
            {m.manual && <span className="text-xs text-blue-600">手动</span>}
            <button
              onClick={() => remove(m.user_id, m.track)}
              className="ml-auto text-xs text-dim hover:text-red-600"
            >
              移除
            </button>
          </div>
        ))}
        {members.length === 0 && <p className="py-4 text-center text-sm text-dim">暂无会员</p>}
      </div>
    </div>
  )
}

function MembershipBody() {
  const [tab, setTab] = useState<TabKey>('tiers')
  return (
    <>
      <TabBar tabs={[...TABS]} active={tab} onChange={(k) => setTab(k as TabKey)} />
      {tab === 'tiers' && <TiersTab />}
      {tab === 'members' && <MembersTab />}
    </>
  )
}

export default function AdminMembership() {
  return <AdminGate>{() => <MembershipBody />}</AdminGate>
}
