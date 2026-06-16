import { useMemo, useState, type FormEvent } from 'react'
import { send } from '../api'
import { Field, Leader, Modal, Paginator, PillBtn, specInput, usePagination } from '../spec'
import { actionBtn, type PaperDto, type SizeDto } from './types'

function PaperEditModal({
  paper,
  sizes,
  onClose,
  onChanged,
}: {
  paper: PaperDto
  sizes: SizeDto[]
  onClose: () => void
  onChanged: () => void
}) {
  const [name, setName] = useState(paper.name)
  const [gsm, setGsm] = useState(paper.gsm == null ? '' : String(paper.gsm))
  const [category, setCategory] = useState(paper.category ?? '')
  const [supplier, setSupplier] = useState(paper.supplier ?? '')
  const [attrError, setAttrError] = useState<string | null>(null)
  const [attrOk, setAttrOk] = useState(false)

  const [sizeKey, setSizeKey] = useState('')
  const [packPrice, setPackPrice] = useState('')
  const [packCount, setPackCount] = useState('')
  const [costError, setCostError] = useState<string | null>(null)

  const saveAttr = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === '') { setAttrError('名称不能为空'); return }
    const res = await send('PATCH', `/api/pricing/papers/${paper.id}`, {
      name: name.trim(),
      gsm: gsm.trim() === '' ? null : Math.trunc(Number(gsm)),
      category: category.trim() === '' ? null : category.trim(),
      supplier: supplier.trim() === '' ? null : supplier.trim(),
    })
    if (res.ok) { setAttrError(null); setAttrOk(true); onChanged(); setTimeout(() => setAttrOk(false), 1500) }
    else setAttrError('保存失败')
  }

  const addCost = async (e: FormEvent) => {
    e.preventDefault()
    const price = Math.trunc(Number(packPrice))
    const count = Math.trunc(Number(packCount))
    if (sizeKey === '' || price < 0 || count < 1) {
      setCostError('选择尺寸并填写非负整数包价（_c）与正整数包内张数')
      return
    }
    const res = await send('PUT', '/api/pricing/paper-size-costs', {
      paper_id: paper.id,
      size_key: sizeKey,
      pack_price_c: price,
      pack_count: count,
    })
    if (res.ok) {
      setSizeKey('')
      setPackPrice('')
      setPackCount('')
      setCostError(null)
      onChanged()
    } else setCostError('保存失败')
  }

  const deleteCost = async (sk: string) => {
    const res = await send('DELETE', `/api/pricing/paper-size-costs/${paper.id}/${sk}`)
    if (res.ok) onChanged()
  }

  return (
    <Modal open wide title={`编辑纸张 · ${paper.name}`} onClose={onClose}>
      {/* Attributes */}
      <form onSubmit={(e) => void saveAttr(e)} className="grid grid-cols-2 items-end gap-3">
        <Field label="名称">
          <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="克重 gsm">
          <input type="number" min={1} className={specInput} value={gsm} onChange={(e) => setGsm(e.target.value)} />
        </Field>
        <Field label="类别">
          <input type="text" className={specInput} value={category} onChange={(e) => setCategory(e.target.value)} />
        </Field>
        <Field label="供应商">
          <input type="text" className={specInput} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <div className="col-span-2 flex items-center gap-3">
          <PillBtn>保存属性</PillBtn>
          {attrOk && <span className="text-[12px] text-ink">已保存</span>}
          {attrError && <span className="text-[12px] text-wine-ink">{attrError}</span>}
        </div>
      </form>

      {/* Separator */}
      <div className="my-5 border-t border-line" />

      {/* Size costs */}
      <span className="mb-2 block font-mono text-[10px] tracking-[.14em] text-dim">尺寸口径 · SIZE COSTS</span>

      {paper.size_costs.length > 0 && (
        <table className="mb-3 w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="pb-1.5 font-mono text-[10px] tracking-[.12em] text-dim">尺寸</th>
              <th className="pb-1.5 font-mono text-[10px] tracking-[.12em] text-dim">整包价 _c</th>
              <th className="pb-1.5 font-mono text-[10px] tracking-[.12em] text-dim">张数</th>
              <th className="pb-1.5 font-mono text-[10px] tracking-[.12em] text-dim">单张 _c</th>
              <th className="w-12 pb-1.5" />
            </tr>
          </thead>
          <tbody>
            {paper.size_costs.map((c) => (
              <tr key={c.size_key} className="border-b border-line last:border-b-0">
                <td className="py-[5px] font-medium text-ink">{c.size_key}</td>
                <td className="py-[5px] font-mono text-dim">{c.pack_price_c.toLocaleString()}</td>
                <td className="py-[5px] font-mono text-dim">{c.pack_count.toLocaleString()}</td>
                <td className="py-[5px] font-mono text-ink">{Math.round(c.pack_price_c / c.pack_count)}</td>
                <td className="py-[5px] text-right">
                  <button type="button" className={`${actionBtn} text-dim`} onClick={() => void deleteCost(c.size_key)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={(e) => void addCost(e)} className="flex flex-wrap items-end gap-3">
        <Field label="尺寸">
          <select className={specInput} value={sizeKey} onChange={(e) => setSizeKey(e.target.value)}>
            <option value="">— 选择 —</option>
            {sizes.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="整包价 _c">
          <input type="number" min={0} required className={specInput} value={packPrice} onChange={(e) => setPackPrice(e.target.value)} />
        </Field>
        <Field label="包内张数">
          <input type="number" min={1} required className={specInput} value={packCount} onChange={(e) => setPackCount(e.target.value)} />
        </Field>
        <PillBtn>写入口径</PillBtn>
        {costError && <p className="w-full text-[12px] text-wine-ink">{costError}</p>}
      </form>
    </Modal>
  )
}

export default function PapersTab({
  papers,
  sizes,
  onChanged,
}: {
  papers: PaperDto[]
  sizes: SizeDto[]
  onChanged: () => void
}) {
  const [search, setSearch] = useState('')
  const [editingPaper, setEditingPaper] = useState<PaperDto | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const [name, setName] = useState('')
  const [gsm, setGsm] = useState('')
  const [category, setCategory] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const active = useMemo(() => papers.filter((p) => p.archived === 0), [papers])

  const filtered = useMemo(() => {
    if (!search.trim()) return active
    const s = search.toLowerCase()
    return active.filter(
      (p) =>
        p.name.toLowerCase().includes(s) ||
        (p.category ?? '').toLowerCase().includes(s) ||
        (p.supplier ?? '').toLowerCase().includes(s),
    )
  }, [active, search])

  const { page, totalPages, paged, setPage } = usePagination(filtered, 15)

  const addPaper = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === '') return
    const res = await send('POST', '/api/pricing/papers', {
      name: name.trim(),
      gsm: gsm.trim() === '' ? null : Math.trunc(Number(gsm)),
      category: category.trim() === '' ? null : category.trim(),
    })
    if (res.ok) {
      setName('')
      setGsm('')
      setCategory('')
      setNotice('纸张已建——补好尺寸口径才可参与报价')
      setShowAdd(false)
      onChanged()
    } else setNotice('创建失败')
  }

  // Keep modal paper in sync with refreshed data
  const livePaper = editingPaper ? active.find((p) => p.id === editingPaper.id) ?? null : null

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-4 pt-5">
        <input
          type="text"
          placeholder="搜索纸张…"
          className="w-48 border border-line bg-card px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-dim/60 focus:border-wine"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="ml-auto">
          <button
            type="button"
            className={`${actionBtn} text-wine-ink`}
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? '收起' : '+ 新增纸张'}
          </button>
        </div>
      </div>

      {/* Add paper form */}
      {showAdd && (
        <form onSubmit={(e) => void addPaper(e)} className="mt-4 flex flex-wrap items-end gap-3 border border-ink bg-card p-4">
          <span className="w-full font-mono text-[10px] tracking-[.14em] text-dim">NEW PAPER</span>
          <Field label="名称">
            <input type="text" required className={specInput} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="克重 gsm（可空）">
            <input type="number" min={1} className={specInput} value={gsm} onChange={(e) => setGsm(e.target.value)} />
          </Field>
          <Field label="类别（可空）">
            <input type="text" className={specInput} value={category} onChange={(e) => setCategory(e.target.value)} />
          </Field>
          <PillBtn>新增纸张</PillBtn>
          {notice && <p className="w-full text-[12px] text-wine-ink">{notice}</p>}
        </form>
      )}

      {/* Table */}
      <div className="mt-4 overflow-x-auto border border-ink">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-ink bg-card">
              <th className="px-4 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">名称</th>
              <th className="px-3 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">克重</th>
              <th className="px-3 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">类别</th>
              <th className="px-3 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">供应商</th>
              <th className="px-3 py-2.5 text-left font-mono text-[10.5px] tracking-[.14em] text-dim">口径</th>
              <th className="w-20 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {paged.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-b-0">
                <td className="px-4 py-[9px] font-medium text-ink">{p.name}</td>
                <td className="px-3 py-[9px] font-mono text-[12px] text-dim">{p.gsm != null ? `${p.gsm}g` : '—'}</td>
                <td className="px-3 py-[9px] text-[12px] text-dim">{p.category ?? '—'}</td>
                <td className="px-3 py-[9px] text-[12px] text-dim">{p.supplier ?? '—'}</td>
                <td className="px-3 py-[9px] font-mono text-[11px] text-dim">
                  {p.size_costs.length > 0
                    ? p.size_costs.map((c) => c.size_key).join(' · ')
                    : '无口径'}
                </td>
                <td className="px-3 py-[9px]">
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      className={`${actionBtn} text-wine-ink`}
                      onClick={() => setEditingPaper(p)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className={`${actionBtn} text-dim`}
                      onClick={() => {
                        if (window.confirm(`归档纸张「${p.name}」？`)) {
                          void send('DELETE', `/api/pricing/papers/${p.id}`).then((r) => r.ok && onChanged())
                        }
                      }}
                    >
                      归档
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[13px] text-dim">
                  {search ? '无匹配结果' : '暂无纸张'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {livePaper && (
        <PaperEditModal
          key={livePaper.id}
          paper={livePaper}
          sizes={sizes}
          onClose={() => setEditingPaper(null)}
          onChanged={onChanged}
        />
      )}

      <Paginator page={page} totalPages={totalPages} onPage={setPage} />

      <div className="pt-3 text-right font-mono text-[10px] tracking-[.1em] text-dim">
        {active.length} 种纸张
      </div>
    </div>
  )
}
