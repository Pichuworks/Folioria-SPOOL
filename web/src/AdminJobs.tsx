import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import AdminGate from './AdminGate'
import {
  completeJob,
  consumeHighlightJobId,
  createJob,
  fetchJobPreview,
  fetchJobRecommend,
  fetchJobs,
  fetchOptions,
  getJobsCache,
  getOptionsCache,
  patchJobStatus,
  reassignJobMode,
  type JobDto,
  type JobPreviewDto,
  type MachineRecDto,
  type OptionsDto,
} from './api'
import { Field, Leader, MagSec, Paginator, PillBtn, Skeleton, SpecRow, TabBar, specInput, toast, usePagination } from './spec'

const STATUS_ORDER = ['draft', 'queued', 'printing', 'done', 'cancelled'] as const
const STATUS_LABEL: Record<JobDto['status'], string> = {
  draft: '草稿',
  queued: '排队',
  printing: '印中',
  done: '完成',
  cancelled: '已取消',
}

const actionBtn = 'font-mono text-[10px] tracking-[.14em] hover:opacity-70'

function DonePanel({ job, onDone }: { job: JobDto; onDone: () => void }) {
  const [waste, setWaste] = useState(0)
  const [pages, setPages] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const body: { waste_quantity: number; pages_consumed?: number } = { waste_quantity: waste }
    const p = Number(pages)
    if (pages.trim() !== '' && Number.isSafeInteger(p) && p >= 1) body.pages_consumed = p
    const res = await completeJob(job.id, body)
    if (res.ok) { toast('作业已完成，库存已落账', 'ok'); return onDone() }
    const msgs: Record<string, string> = {
      no_stock_record: '落账失败：该纸×尺寸不存在库存档案，请先录入库存',
      unit_cost_underivable: '落账失败：成本推导失败，请检查机台/纸张/尺寸配置',
    }
    setError(msgs[res.error] ?? `落账失败（${res.error}）`)
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-2 flex flex-wrap items-end gap-4 border border-line bg-card p-4"
    >
      <Field label="废品数（张）">
        <input
          type="number"
          min={0}
          className={specInput}
          value={waste}
          onChange={(e) => setWaste(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
        />
      </Field>
      <Field label="实耗面数（留空 = 按单双面推算）">
        <input
          type="number"
          min={1}
          className={specInput}
          placeholder={`默认 (${job.quantity}+废品)×面`}
          value={pages}
          onChange={(e) => setPages(e.target.value)}
        />
      </Field>
      <PillBtn>完成落账</PillBtn>
      {error && <p className="w-full text-[12px] text-wine-ink">{error}</p>}
    </form>
  )
}

function ReassignPanel({ job, onChanged }: { job: JobDto; onChanged: () => void }) {
  const [recs, setRecs] = useState<MachineRecDto[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchJobRecommend(job.paper_id, job.size_key).then((r) => { if (!cancelled) setRecs(r) })
    return () => { cancelled = true }
  }, [job.paper_id, job.size_key])
  const pick = async (modeId: number) => {
    if (await reassignJobMode(job.id, modeId)) onChanged()
  }
  const tone = (s: string) =>
    s === 'online' ? 'text-ink' : s === 'offline' || s === 'maintenance' ? 'text-warn' : 'text-dim'
  return (
    <div className="mt-2 border border-line bg-deep/40 p-3">
      <div className="mb-2 font-mono text-[10px] tracking-[.12em] text-dim">RECOMMEND · 在线优先 / 成本升序 / 负载</div>
      {!recs ? (
        <p className="text-[12px] text-dim">加载中…</p>
      ) : recs.length === 0 ? (
        <p className="text-[12px] text-dim">无可用机台</p>
      ) : (
        recs.map((r) => (
          <div key={r.mode_id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-[6px] last:border-b-0">
            <span className="text-[13px] text-ink">{r.mode_name}</span>
            <span className={`font-mono text-[10px] tracking-[.1em] ${tone(r.printer_status)}`}>
              {r.printer_status.toUpperCase()}
            </span>
            <span className="font-mono text-[11px] text-dim">
              成本 {r.unit_cost_display}/张 · 队列 {r.queue_pages}P
            </span>
            <Leader />
            {r.mode_id === job.mode_id ? (
              <span className="font-mono text-[10px] tracking-[.1em] text-wine-ink">当前</span>
            ) : (
              <button type="button" className="font-mono text-[11px] text-wine-ink hover:opacity-70" onClick={() => void pick(r.mode_id)}>
                改派此机 →
              </button>
            )}
          </div>
        ))
      )}
    </div>
  )
}

const JobRow = memo(function JobRow({ job, onChanged, highlight }: { job: JobDto; onChanged: () => void; highlight?: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const [reassignOpen, setReassignOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (highlight && rowRef.current) rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlight])

  const transition = async (status: 'queued' | 'printing' | 'cancelled') => {
    if (status === 'cancelled' && !window.confirm(`确认取消「${job.title}」？`)) return
    if (await patchJobStatus(job.id, status)) { toast(`作业已变更为 ${STATUS_LABEL[status] ?? status}`, 'ok'); onChanged() }
    else setError('状态变更失败，请刷新后重试')
  }

  const act = (label: string, status: 'queued' | 'printing' | 'cancelled', tone: string) => (
    <button type="button" className={`${actionBtn} ${tone}`} onClick={() => void transition(status)}>
      {label}
    </button>
  )

  return (
    <div ref={rowRef} className={`border-b border-line py-[9px] ${highlight ? 'bg-wine-dim/20' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[14px] font-medium tracking-[.04em] text-ink">{job.title}</span>
        <span className="text-[12px] text-dim">
          {job.mode_name} × {job.paper_name} × {job.size_key} · {job.quantity} 张
        </span>
        <span className="font-mono text-[10px] tracking-[.1em] text-dim">{job.created_at.slice(0, 10)}</span>
        <Leader />
        {job.status === 'done' ? (
          <span className="flex items-baseline gap-3 font-mono text-[12px] tracking-[.04em]">
            <span className="text-ink">成本 {job.total_cost_display}</span>
            {job.profit === null ? (
              <span className="text-dim">内部</span>
            ) : (
              <span className={job.profit < 0 ? 'text-warn' : 'text-wine-ink'}>
                毛利 {job.profit_display}
              </span>
            )}
          </span>
        ) : job.status === 'cancelled' ? (
          <span className="font-mono text-[10px] tracking-[.14em] text-dim">CANCELLED</span>
        ) : (
          <span className="flex items-baseline gap-4">
            {job.quoted_price_display && (
              <span className="font-mono text-[12px] text-dim">报价 {job.quoted_price_display}</span>
            )}
            {job.status === 'draft' && act('排队 →', 'queued', 'text-wine-ink')}
            {job.status === 'queued' && act('开印 →', 'printing', 'text-wine-ink')}
            {job.status === 'printing' && (
              <button
                type="button"
                className={`${actionBtn} text-wine-ink`}
                onClick={() => setDoneOpen((v) => !v)}
              >
                完成…
              </button>
            )}
            <button type="button" className={`${actionBtn} text-dim`} onClick={() => setReassignOpen((v) => !v)}>
              改派…
            </button>
            {act('取消', 'cancelled', 'text-dim')}
          </span>
        )}
      </div>
      {error && <p className="mt-1 text-[12px] text-wine-ink">{error}</p>}
      {doneOpen && job.status === 'printing' && (
        <DonePanel
          job={job}
          onDone={() => {
            setDoneOpen(false)
            onChanged()
          }}
        />
      )}
      {reassignOpen && job.status !== 'done' && job.status !== 'cancelled' && (
        <ReassignPanel
          job={job}
          onChanged={() => {
            setReassignOpen(false)
            onChanged()
          }}
        />
      )}
    </div>
  )
})

const BOOK_ROLE_LABEL: Record<string, string> = { cover: '封面', inner: '内页', insert: '插图' }

type RenderUnit = { kind: 'job'; job: JobDto } | { kind: 'book'; bookId: string; bookName: string; jobs: JobDto[] }

function groupByBook(list: JobDto[]): RenderUnit[] {
  const units: RenderUnit[] = []
  const idx = new Map<string, number>()
  for (const j of list) {
    if (j.order_book_id) {
      const at = idx.get(j.order_book_id)
      if (at != null) (units[at] as Extract<RenderUnit, { kind: 'book' }>).jobs.push(j)
      else {
        idx.set(j.order_book_id, units.length)
        units.push({ kind: 'book', bookId: j.order_book_id, bookName: j.book_name ?? '书册', jobs: [j] })
      }
    } else {
      units.push({ kind: 'job', job: j })
    }
  }
  return units
}

const BookJobGroup = memo(function BookJobGroup({ unit, onChanged, highlightId }: { unit: Extract<RenderUnit, { kind: 'book' }>; onChanged: () => void; highlightId?: string | null }) {
  return (
    <div className="my-1.5 border-l-2 border-wine/40 pl-3">
      <div className="flex items-baseline gap-2 pt-1.5 text-[12.5px]">
        <span className="font-medium text-ink">📖 {unit.bookName}</span>
        <span className="font-mono text-[10px] tracking-[.1em] text-dim">
          {unit.jobs.length} 组件 ·{' '}
          {unit.jobs.map((j) => BOOK_ROLE_LABEL[j.book_role ?? ''] ?? j.book_role).filter(Boolean).join('/')}
        </span>
      </div>
      {unit.jobs.map((j) => (
        <JobRow key={j.id} job={j} onChanged={onChanged} highlight={j.id === highlightId} />
      ))}
    </div>
  )
})

const JOBS_PAGE_SIZE = 20

type PreviewState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

function CreateJobPanel({
  options,
  tick,
  onCreated,
  onClose,
}: {
  options: OptionsDto
  tick: number
  onCreated: () => void
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [modeId, setModeId] = useState<number | null>(null)
  const [paperId, setPaperId] = useState<number | null>(null)
  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(100)
  const [quotedPrice, setQuotedPrice] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const [preview, setPreview] = useState<JobPreviewDto | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState>('idle')

  const papersForMode = useMemo(() => {
    if (modeId === null) return []
    const ids = new Set(options.options.filter((o) => o.mode_id === modeId).map((o) => o.paper_id))
    return options.papers.filter((p) => ids.has(p.id))
  }, [options, modeId])

  const pricesForPair = useMemo(() => {
    if (modeId === null || paperId === null) return null
    return options.options.find((o) => o.mode_id === modeId && o.paper_id === paperId)?.prices ?? null
  }, [options, modeId, paperId])

  useEffect(() => {
    setPreview(null)
    if (modeId === null || paperId === null || sizeKey === null || quantity < 1) {
      setPreviewState('idle')
      return
    }
    setPreviewState('loading')
    const ctl = new AbortController()
    fetchJobPreview({ mode_id: modeId, paper_id: paperId, size_key: sizeKey, quantity })
      .then((p) => {
        if (ctl.signal.aborted) return
        setPreview(p)
        setPreviewState(p ? 'ready' : 'unavailable')
      })
      .catch(() => {
        if (!ctl.signal.aborted) setPreviewState('error')
      })
    return () => ctl.abort()
  }, [modeId, paperId, sizeKey, quantity, tick])

  const shortage = preview !== null && preview.available < quantity

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (modeId === null || paperId === null || sizeKey === null || title.trim() === '') return
    const qp = quotedPrice.trim() === '' ? null : Number(quotedPrice)
    if (qp !== null && (!Number.isSafeInteger(qp) || qp < 0)) {
      setNotice('报价金额须为非负整数（金额层）')
      return
    }
    const created = await createJob({
      title: title.trim(),
      mode_id: modeId,
      paper_id: paperId,
      size_key: sizeKey,
      quantity,
      quoted_price: qp,
    })
    if (!created) {
      setNotice('创建失败，请检查配置')
      return
    }
    setNotice(
      created.availability_warning
        ? `已创建「${created.title}」—— 该纸×尺寸可用量不足，注意补纸`
        : `已创建「${created.title}」`,
    )
    setTitle('')
    setQuotedPrice('')
    onCreated()
  }

  return (
    <div className="mb-8 border border-ink">
      <div className="flex items-center justify-between border-b border-line px-7 py-3">
        <span className="font-mono text-[10px] tracking-[.14em] text-dim">NEW INTERNAL JOB</span>
        <button type="button" className="font-mono text-[11px] tracking-[.1em] text-dim hover:text-ink" onClick={onClose}>
          收起 ✕
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 md:grid-cols-[5fr_7fr]">
        <div className="space-y-5 border-b border-line p-7 md:border-b-0 md:border-r">
          <Field label="标题">
            <input
              type="text"
              required
              className={specInput}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="打印模式">
            <select
              className={specInput}
              value={modeId ?? ''}
              onChange={(e) => {
                setModeId(e.target.value === '' ? null : Number(e.target.value))
                setPaperId(null)
                setSizeKey(null)
              }}
            >
              <option value="">— 选择 —</option>
              {options.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="纸张">
            <select
              className={specInput}
              value={paperId ?? ''}
              disabled={modeId === null}
              onChange={(e) => {
                setPaperId(e.target.value === '' ? null : Number(e.target.value))
                setSizeKey(null)
              }}
            >
              <option value="">— 选择 —</option>
              {papersForMode.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="尺寸">
            <select
              className={specInput}
              value={sizeKey ?? ''}
              disabled={pricesForPair === null}
              onChange={(e) => setSizeKey(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">— 选择 —</option>
              {options.sizes
                .filter((s) => pricesForPair && s.key in pricesForPair)
                .map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="数量（张）">
            <input
              type="number"
              min={1}
              className={specInput}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
            />
          </Field>
          <Field label="报价金额（整数 · 留空 = 内部作业）">
            <input
              type="number"
              min={0}
              className={specInput}
              value={quotedPrice}
              onChange={(e) => setQuotedPrice(e.target.value)}
            />
          </Field>
          <PillBtn full>创建作业（草稿）</PillBtn>
          {notice && <p className="text-[12.5px] text-wine-ink">{notice}</p>}
        </div>

        <div className="flex flex-col p-7">
          <div className="font-mono text-[10px] tracking-[.14em] text-dim">COST PREVIEW · ADMIN ONLY</div>
          {previewState === 'ready' && preview ? (
            <div className="flex flex-1 flex-col">
              <div className="mt-3">
                <SpecRow label="墨水" note="每张" value={preview.ink_display} />
                <SpecRow label="纸张" note="每张" value={preview.paper_display} />
                <SpecRow label="折旧摊薄" note="每张" value={preview.overhead_display} />
                <SpecRow label="单张成本" value={preview.unit_total_display} strong />
                <SpecRow label="预估总成本" note={`× ${quantity} 张`} value={preview.est_total_display ?? '—'} strong />
              </div>
              <div className="mt-auto pt-6">
                <div className="border-t-2 border-ink pt-3">
                  <SpecRow label="账面" note="该纸×尺寸" value={`${preview.on_hand} 张`} />
                  <SpecRow label="排队占用" note="queued + printing" value={`${preview.reserved} 张`} />
                  <div className="flex items-baseline gap-3.5 py-[11px]">
                    <span className="min-w-24 text-[15px] font-medium text-ink">可用量</span>
                    <Leader />
                    <span
                      className={`font-mono text-[15px] tracking-[.05em] ${shortage ? 'text-warn' : 'text-wine-ink'}`}
                    >
                      {preview.available} 张{shortage ? ' · 不足' : ''}
                    </span>
                  </div>
                </div>
                <p className="mt-2 text-right font-mono text-[10px] tracking-[.12em] text-dim">
                  AVAILABLE = ON HAND − RESERVED · §3.3
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center py-12">
              <p className="text-[13px] leading-[1.85] text-dim">
                {previewState === 'loading'
                  ? '推导中…'
                  : previewState === 'unavailable'
                    ? '该组合成本不可推导，请调整配置。'
                    : previewState === 'error'
                      ? '预览服务暂时不可用。'
                      : '选定模式×纸张×尺寸后，成本与可用量即时出现。'}
              </p>
            </div>
          )}
        </div>
      </form>
    </div>
  )
}

function JobsBody() {
  const [options, setOptions] = useState<OptionsDto | null>(getOptionsCache)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<JobDto[] | null>(getJobsCache)
  const [tick, setTick] = useState(0)
  const [highlightId] = useState<string | null>(() => consumeHighlightJobId())

  const [createOpen, setCreateOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<JobDto['status']>('queued')
  const highlightApplied = useRef(false)

  useEffect(() => {
    let cancelled = false
    fetchOptions()
      .then((o) => { if (!cancelled) setOptions(o) })
      .catch(() => { if (!cancelled && !getOptionsCache()) setOptionsError('配置数据加载失败') })
    return () => { cancelled = true }
  }, [])

  const reloadJobs = useCallback(() => {
    fetchJobs().then(setJobs).catch(() => {
      if (!getJobsCache()) setJobs(null)
    })
  }, [])
  useEffect(() => {
    let cancelled = false
    fetchJobs()
      .then((j) => { if (!cancelled) setJobs(j) })
      .catch(() => { if (!cancelled && !getJobsCache()) setJobs(null) })
    return () => { cancelled = true }
  }, [])

  const onMutated = useCallback(() => {
    reloadJobs()
    setTick((t) => t + 1)
  }, [reloadJobs])

  const groups = useMemo(() => {
    const g: Record<JobDto['status'], JobDto[]> = {
      draft: [],
      queued: [],
      printing: [],
      done: [],
      cancelled: [],
    }
    for (const j of jobs ?? []) g[j.status].push(j)
    return g
  }, [jobs])

  useEffect(() => {
    if (highlightApplied.current || !highlightId || !jobs) return
    const found = jobs.find((j) => j.id === highlightId)
    if (found) {
      setActiveTab(found.status)
      highlightApplied.current = true
    }
  }, [highlightId, jobs])

  const tabs = useMemo(
    () => STATUS_ORDER.map((s) => ({ key: s, label: STATUS_LABEL[s], count: groups[s].length })),
    [groups],
  )

  const activeJobs = groups[activeTab]
  const units = useMemo(() => groupByBook(activeJobs), [activeJobs])
  const { page, totalPages, paged, setPage } = usePagination(units, JOBS_PAGE_SIZE)

  const switchTab = useCallback((key: string) => {
    setActiveTab(key as JobDto['status'])
    setPage(0)
  }, [setPage])

  if (optionsError) return <p className="pt-13 text-[14px] text-wine-ink">{optionsError}</p>
  if (!options) return <Skeleton />

  return (
    <div>
      <MagSec
        title="作业台账"
        note={jobs ? `${jobs.length} 条` : undefined}
      >
        <div className="mb-6 flex items-center gap-4">
          <button
            type="button"
            className={
              createOpen
                ? 'rounded-full border border-wine bg-wine-dim/30 px-4 py-2 text-[13px] font-medium text-wine-ink'
                : 'rounded-full border border-line px-4 py-2 text-[13px] font-medium text-ink hover:border-wine hover:text-wine-ink'
            }
            onClick={() => setCreateOpen((v) => !v)}
          >
            + 新建内部作业
          </button>
        </div>

        {createOpen && (
          <CreateJobPanel
            options={options}
            tick={tick}
            onCreated={() => {
              onMutated()
              switchTab('draft')
            }}
            onClose={() => setCreateOpen(false)}
          />
        )}

        <TabBar tabs={tabs} active={activeTab} onChange={switchTab} />

        {jobs === null ? (
          <p className="py-6 text-[13px] text-dim">台账加载中…</p>
        ) : activeJobs.length === 0 ? (
          <p className="py-6 text-[12px] text-dim">—</p>
        ) : (
          <div className="pt-2">
            {paged.map((u) =>
              u.kind === 'book' ? (
                <BookJobGroup key={u.bookId} unit={u} onChanged={onMutated} highlightId={highlightId} />
              ) : (
                <JobRow key={u.job.id} job={u.job} onChanged={onMutated} highlight={u.job.id === highlightId} />
              ),
            )}
            <Paginator page={page} totalPages={totalPages} onPage={setPage} />
          </div>
        )}
      </MagSec>
    </div>
  )
}

export default function AdminJobs() {
  return <AdminGate>{() => <JobsBody />}</AdminGate>
}
