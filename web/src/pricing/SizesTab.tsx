import { useState, type FormEvent } from 'react'
import { send } from '../api'
import { Field, PillBtn, specInput } from '../spec'
import { actionBtn, type SizeDto } from './types'

function SizeEditCell({
  value,
  onSave,
  placeholder,
  type = 'number',
}: {
  value: string
  onSave: (v: string) => Promise<boolean>
  placeholder?: string
  type?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  if (!editing) {
    return (
      <span
        className="cursor-pointer rounded px-1 py-0.5 hover:bg-deep"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
      >
        {value || <span className="text-dim/50">{placeholder ?? '—'}</span>}
      </span>
    )
  }

  const commit = async () => {
    setSaving(true)
    const ok = await onSave(draft)
    setSaving(false)
    if (ok) setEditing(false)
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type={type}
        className="w-16 border border-wine bg-card px-1 py-0.5 text-center text-ink outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        autoFocus
        disabled={saving}
      />
      <button
        type="button"
        className="text-[10px] text-wine-ink hover:opacity-70"
        onClick={() => void commit()}
        disabled={saving}
      >
        OK
      </button>
      <button
        type="button"
        className="text-[10px] text-dim hover:opacity-70"
        onClick={() => setEditing(false)}
      >
        ×
      </button>
    </span>
  )
}

export default function SizesTab({
  sizes,
  onChanged,
}: {
  sizes: SizeDto[]
  onChanged: () => void
}) {
  const [form, setForm] = useState({ key: '', label: '', area: '', sort: '', width_mm: '', height_mm: '' })
  const [notice, setNotice] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const patchSize = async (key: string, field: string, raw: string): Promise<boolean> => {
    const val = raw.trim() === '' ? null : Number(raw)
    if (val !== null && isNaN(val)) return false
    const res = await send('PATCH', `/api/pricing/sizes/${key}`, { [field]: val })
    if (res.ok) { onChanged(); return true }
    return false
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const area = Number(form.area)
    if (form.key.trim() === '' || form.label.trim() === '' || !(area > 0)) {
      setNotice('key / 标签非空，相对面积为正数')
      return
    }
    const mm = (s: string) => (s.trim() === '' ? null : Math.trunc(Number(s)))
    const res = await send('POST', '/api/pricing/sizes', {
      key: form.key.trim(),
      label: form.label.trim(),
      area,
      sort: form.sort.trim() === '' ? 0 : Math.trunc(Number(form.sort)),
      width_mm: mm(form.width_mm),
      height_mm: mm(form.height_mm),
    })
    if (res.ok) {
      setForm({ key: '', label: '', area: '', sort: '', width_mm: '', height_mm: '' })
      setNotice(null)
      setShowAdd(false)
      onChanged()
    } else setNotice(res.status === 409 ? '该 key 已存在' : '创建失败')
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-4 pt-5">
        <span className="font-mono text-[10.5px] tracking-[.12em] text-dim">
          点击单元格可直接编辑
        </span>
        <div className="ml-auto">
          <button
            type="button"
            className={`${actionBtn} text-wine-ink`}
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? '收起' : '+ 新增尺寸'}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto border border-ink">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-ink bg-card">
              <th className="px-4 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">Key</th>
              <th className="px-3 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">标签</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">相对面积</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">排序</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">宽 mm</th>
              <th className="px-3 py-2.5 text-right font-mono text-[10.5px] tracking-[.14em] text-dim">高 mm</th>
              <th className="w-16 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {sizes.map((s) => (
              <tr key={s.key} className="border-b border-line last:border-b-0">
                <td className="px-4 py-[8px] font-medium text-ink">{s.key}</td>
                <td className="px-3 py-[8px] text-ink">{s.label}</td>
                <td className="px-3 py-[8px] text-right font-mono text-ink">
                  <SizeEditCell
                    value={String(s.area)}
                    onSave={(v) => patchSize(s.key, 'area', v)}
                    placeholder="0"
                  />
                </td>
                <td className="px-3 py-[8px] text-right font-mono text-dim">
                  <SizeEditCell
                    value={String(s.sort)}
                    onSave={(v) => patchSize(s.key, 'sort', v)}
                    placeholder="0"
                  />
                </td>
                <td className="px-3 py-[8px] text-right font-mono text-dim">
                  <SizeEditCell
                    value={s.width_mm == null ? '' : String(s.width_mm)}
                    onSave={(v) => patchSize(s.key, 'width_mm', v)}
                    placeholder="—"
                  />
                </td>
                <td className="px-3 py-[8px] text-right font-mono text-dim">
                  <SizeEditCell
                    value={s.height_mm == null ? '' : String(s.height_mm)}
                    onSave={(v) => patchSize(s.key, 'height_mm', v)}
                    placeholder="—"
                  />
                </td>
                <td className="px-3 py-[8px] text-right">
                  <button
                    type="button"
                    className={`${actionBtn} text-dim`}
                    onClick={() => {
                      if (!window.confirm(`删除尺寸 ${s.key}？被引用时会被拒绝。`)) return
                      void send('DELETE', `/api/pricing/sizes/${s.key}`).then((r) => {
                        if (r.ok) onChanged()
                        else setNotice(r.status === 409 ? `${s.key} 被引用，禁止删除` : '删除失败')
                      })
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add size form */}
      {showAdd && (
        <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
          <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW SIZE</span>
          <Field label="key">
            <input type="text" required className={specInput} value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
          </Field>
          <Field label="标签">
            <input type="text" required className={specInput} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
          </Field>
          <Field label="相对面积">
            <input type="number" step="any" min={0} required className={specInput} value={form.area} onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))} />
          </Field>
          <Field label="排序">
            <input type="number" className={specInput} value={form.sort} onChange={(e) => setForm((f) => ({ ...f, sort: e.target.value }))} />
          </Field>
          <Field label="宽 mm（可空）">
            <input type="number" min={1} className={specInput} value={form.width_mm} onChange={(e) => setForm((f) => ({ ...f, width_mm: e.target.value }))} />
          </Field>
          <Field label="高 mm（可空）">
            <input type="number" min={1} className={specInput} value={form.height_mm} onChange={(e) => setForm((f) => ({ ...f, height_mm: e.target.value }))} />
          </Field>
          <PillBtn>新增尺寸</PillBtn>
          {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
        </form>
      )}

      {notice && !showAdd && (
        <p className="mt-3 text-[12px] text-wine-ink">{notice}</p>
      )}

      <div className="pt-3 text-right font-mono text-[10px] tracking-[.1em] text-dim">
        {sizes.length} 种尺寸
      </div>
    </div>
  )
}
