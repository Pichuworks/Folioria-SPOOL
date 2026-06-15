import { useMemo, useState, type FormEvent } from 'react'
import { send } from '../api'
import { Field, Leader, PillBtn, specInput } from '../spec'
import { actionBtn, type BookProductDto, type FinishingDto, type PaperDto, type SizeDto } from './types'

const ROLE_OPTIONS = [
  { v: 'cover', l: '封面' },
  { v: 'inner', l: '内页' },
  { v: 'insert', l: '插图' },
]
const COLOR_OPTIONS = [
  { v: 'bw', l: '黑白' },
  { v: 'color', l: '彩色' },
  { v: 'photo-value', l: '照片·性价比' },
  { v: 'photo-premium', l: '照片·高质量' },
  { v: 'photo-art', l: '照片·艺术微喷' },
]
const PRICING_OPTIONS = [
  { v: 'per_book', l: '按本' },
  { v: 'per_page', l: '按页' },
  { v: 'per_area', l: '按面积' },
]
const roleLabel = (r: string) => ROLE_OPTIONS.find((o) => o.v === r)?.l ?? r
const colorLabel = (c: string) => COLOR_OPTIONS.find((o) => o.v === c)?.l ?? c
const pricingLabel = (p: string) => PRICING_OPTIONS.find((o) => o.v === p)?.l ?? p

function BookPanel({
  book,
  finishings,
  papers,
  sizes,
  onChanged,
}: {
  book: BookProductDto
  finishings: FinishingDto[]
  papers: PaperDto[]
  sizes: SizeDto[]
  onChanged: () => void
}) {
  const [form, setForm] = useState({ role: 'inner', paper_id: '', size_key: '', color_class: 'color', duplex: false })
  const [notice, setNotice] = useState<string | null>(null)
  const paperName = useMemo(() => new Map(papers.map((p) => [p.id, p.name])), [papers])

  const addComp = async (e: FormEvent) => {
    e.preventDefault()
    if (form.paper_id === '' || form.size_key === '') {
      setNotice('选择纸张与尺寸')
      return
    }
    const res = await send('POST', `/api/pricing/books/${book.id}/components`, {
      role: form.role,
      paper_id: Number(form.paper_id),
      size_key: form.size_key,
      color_class: form.color_class,
      duplex: form.duplex,
      sort: book.components.length,
    })
    if (res.ok) {
      setNotice(null)
      onChanged()
    } else setNotice('创建失败（检查纸/尺寸）')
  }

  const toggleFinishing = async (fid: number, on: boolean) => {
    const res = await send(on ? 'PUT' : 'DELETE', `/api/pricing/books/${book.id}/finishings/${fid}`)
    if (res.ok) onChanged()
  }

  const activeComps = book.components.filter((c) => c.archived === 0)
  const activeFinishings = finishings.filter((f) => f.archived === 0)

  return (
    <div className="mt-2 border border-line bg-card p-4">
      <div className="grid gap-6 md:grid-cols-2">
        {/* Components */}
        <div>
          <span className="font-mono text-[10px] tracking-[.14em] text-dim">组件 · COMPONENTS</span>
          {activeComps.length > 0 ? (
            <div className="mt-2 border border-line">
              <table className="w-full border-collapse text-[12px]">
                <tbody>
                  {activeComps.map((c) => (
                    <tr key={c.id} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-[5px] font-medium text-ink">{roleLabel(c.role)}</td>
                      <td className="px-2 py-[5px] text-dim">
                        {colorLabel(c.color_class)} · {paperName.get(c.paper_id) ?? c.paper_id} · {c.size_key}
                        {c.duplex !== 0 ? ' · 双面' : ''}
                      </td>
                      <td className="px-2 py-[5px] text-right">
                        <button
                          type="button"
                          className={`${actionBtn} text-dim`}
                          onClick={() => void send('DELETE', `/api/pricing/book-components/${c.id}`).then((r) => r.ok && onChanged())}
                        >
                          移除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-1 text-[12px] text-dim">暂无组件——至少加一个内页。</p>
          )}

          <form onSubmit={(e) => void addComp(e)} className="mt-3 grid grid-cols-2 items-end gap-2">
            <Field label="角色">
              <select className={specInput} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>{o.l}</option>
                ))}
              </select>
            </Field>
            <Field label="色彩档">
              <select className={specInput} value={form.color_class} onChange={(e) => setForm((f) => ({ ...f, color_class: e.target.value }))}>
                {COLOR_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>{o.l}</option>
                ))}
              </select>
            </Field>
            <Field label="纸张">
              <select className={specInput} value={form.paper_id} onChange={(e) => setForm((f) => ({ ...f, paper_id: e.target.value }))}>
                <option value="">—</option>
                {papers.filter((p) => p.archived === 0).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="尺寸">
              <select className={specInput} value={form.size_key} onChange={(e) => setForm((f) => ({ ...f, size_key: e.target.value }))}>
                <option value="">—</option>
                {sizes.map((s) => (
                  <option key={s.key} value={s.key}>{s.key}</option>
                ))}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-[12px] text-dim">
              <input type="checkbox" checked={form.duplex} onChange={(e) => setForm((f) => ({ ...f, duplex: e.target.checked }))} />
              双面
            </label>
            <PillBtn>加组件</PillBtn>
            {notice && <p className="col-span-2 text-[12px] text-wine-ink">{notice}</p>}
          </form>
        </div>

        {/* Finishings */}
        <div>
          <span className="font-mono text-[10px] tracking-[.14em] text-dim">工艺 · FINISHINGS</span>
          <div className="mt-2 flex flex-col gap-1.5">
            {activeFinishings.length > 0 ? (
              activeFinishings.map((f) => (
                <label key={f.id} className="flex items-center gap-2 text-[12.5px] text-ink">
                  <input
                    type="checkbox"
                    checked={book.finishing_ids.includes(f.id)}
                    onChange={(e) => void toggleFinishing(f.id, e.target.checked)}
                  />
                  {f.name}
                  <span className="text-dim">（{pricingLabel(f.pricing)} {f.price_c.toLocaleString()}_c）</span>
                </label>
              ))
            ) : (
              <span className="text-[12px] text-dim">先在工艺库新增工艺。</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function BooksTab({
  books,
  finishings,
  papers,
  sizes,
  onChanged,
}: {
  books: BookProductDto[]
  finishings: FinishingDto[]
  papers: PaperDto[]
  sizes: SizeDto[]
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const active = books.filter((b) => b.archived === 0)

  const addBook = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === '') return
    const res = await send<{ id: number }>('POST', '/api/pricing/books', { name: name.trim() })
    if (res.ok) {
      setName('')
      setNotice(null)
      setExpanded(res.data.id)
      setShowAdd(false)
      onChanged()
    } else setNotice('创建失败')
  }

  return (
    <div>
      <div className="flex items-baseline gap-2 border-b border-ink pb-1.5">
        <span className="bg-ink px-2 py-0.5 font-mono text-[10px] tracking-[.18em] text-paper">书册</span>
        <span className="font-mono text-[10px] tracking-[.1em] text-dim">BOOK PRODUCTS</span>
        <Leader />
        <button
          type="button"
          className={`${actionBtn} text-wine-ink`}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? '收起' : '+ 新增书册'}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={(e) => void addBook(e)} className="mt-3 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
          <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW BOOK</span>
          <Field label="成品名">
            <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <PillBtn>新增书册</PillBtn>
          {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
        </form>
      )}

      <div className="mt-3">
        {active.map((b) => (
          <div key={b.id} className="border-b border-line py-[8px]">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-[14px] font-medium text-ink">{b.name}</span>
              <span className="font-mono text-[11px] text-dim">
                {b.components.filter((c) => c.archived === 0).length} 组件 · {b.finishing_ids.length} 工艺
              </span>
              <Leader />
              <button
                type="button"
                className={`${actionBtn} text-wine-ink`}
                onClick={() => setExpanded(expanded === b.id ? null : b.id)}
              >
                {expanded === b.id ? '收起' : '编辑'}
              </button>
              <button
                type="button"
                className={`${actionBtn} text-dim`}
                onClick={() => {
                  if (window.confirm(`归档书册「${b.name}」？`)) {
                    void send('DELETE', `/api/pricing/books/${b.id}`).then((r) => r.ok && onChanged())
                  }
                }}
              >
                归档
              </button>
            </div>
            {expanded === b.id && (
              <BookPanel book={b} finishings={finishings} papers={papers} sizes={sizes} onChanged={onChanged} />
            )}
          </div>
        ))}
        {active.length === 0 && (
          <p className="py-8 text-center text-[13px] text-dim">暂无书册成品</p>
        )}
      </div>

      <div className="pt-3 text-right font-mono text-[10px] tracking-[.1em] text-dim">
        {active.length} 书册 · {finishings.filter((f) => f.archived === 0).length} 工艺
      </div>
    </div>
  )
}
