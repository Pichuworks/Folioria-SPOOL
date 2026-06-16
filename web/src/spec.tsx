import { useCallback, useEffect, useMemo, useSyncExternalStore, useState, type ReactNode } from 'react'
import PinnedBanner from './PinnedBanner'

/* Asagaya modern·杂志语域 × eri 配色，全站统一壳：刊头 / 墨标签节头 / 点线行 / 直角控件 / 对折页码 */

export const Leader = () => <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />

export const Shell = ({ nav, center, children }: { nav: ReactNode; center: string; children: ReactNode }) => (
  <div className="min-h-screen bg-paper text-ink">
    <LoadingBar />
    <div className="mx-auto max-w-[1200px] px-5 md:px-10">
      <Masthead nav={nav} />
    </div>
    <PinnedBanner />
    <div className="mx-auto max-w-[1200px] px-5 md:px-10">
      <main className="min-h-[60vh] pb-16">{children}</main>
      <Folio center={center} />
    </div>
  </div>
)

export const Masthead = ({ nav }: { nav: ReactNode }) => (
  <header className="flex flex-wrap items-end justify-between gap-x-[18px] gap-y-5 border-b border-ink pb-4 pt-[30px]">
    <a href="#/" className="flex items-end gap-5 text-ink">
      <span className="ink-press text-[44px] font-bold leading-none tracking-[.14em]">枫光映刻</span>
      <span className="ink-press pb-1 font-script text-[19px] text-dim">Maplescape Folioria</span>
    </a>
    <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 pb-1 text-[13px]">{nav}</nav>
  </header>
)

export function Folio({ center }: { center: string }) {
  const [aboutOpen, setAboutOpen] = useState(false)
  return (
    <>
      <footer className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-ink pb-7 pt-3 font-mono text-[10.5px] tracking-[.14em] text-dim">
        <span>Powered by CRISIRIS S.P.O.O.L.</span>
        <span>{center}</span>
        <button type="button" onClick={() => setAboutOpen(true)} className="cursor-pointer text-dim hover:text-ink">
          v{__APP_VERSION__} · build {__BUILD_NUMBER__} · © 2026 FOLIORIA
        </button>
      </footer>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  )
}

function AboutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40" onClick={onClose}>
      <div className="mx-4 w-full max-w-md border border-ink bg-paper p-8 shadow-e1" onClick={(e) => e.stopPropagation()}>
        {/* 刊头 */}
        <div className="mb-6 border-b border-ink pb-5 text-center">
          <div className="ink-press text-[36px] font-bold leading-none tracking-[.22em]">枫光映刻</div>
          <div className="mt-2 font-script text-[16px] text-dim">Maplescape Folioria</div>
          <div className="mt-3 font-mono text-[10px] tracking-[.3em] text-wine-ink">
            Powered by CRISIRIS S.P.O.O.L.
          </div>
          <div className="mt-1.5 font-mono text-[9px] tracking-[.18em] text-dim">
            STOCK · PRICING · ORDERS · OPERATIONS · LOGISTICS
          </div>
        </div>
        {/* 规格行 */}
        <div className="[&>*:last-child]:border-b-0">
          <AboutRow label="版本" value={`v${__APP_VERSION__}`} />
          <AboutRow label="构建" value={`build ${__BUILD_NUMBER__}`} />
        </div>
        {/* 开发者 */}
        <div className="mt-6 pt-5 text-center">
          <div className="text-[13px] tracking-[.04em] text-ink">Developed by <a href="https://github.com/Pichuworks/" target="_blank" rel="noopener noreferrer" className="font-medium text-ink hover:text-wine-ink">Pichuworks</a></div>
          <div className="mt-3 text-[11px] leading-relaxed tracking-[.02em] text-dim">
            由<br />Crisamielle Aveniris · 诸泪折虹制作委员会<br />提供设计与技术支持
          </div>
        </div>
        {/* 版权 */}
        <div className="mt-5 border-t border-ink pt-4 text-center font-mono text-[10px] tracking-[.14em] text-dim">
          © 2026 Maplescape Folioria. ALL RIGHTS RESERVED.
        </div>
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line px-5 py-2 text-[12px] tracking-[.06em] text-dim hover:border-ink hover:text-ink"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function AboutRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-line py-[9px]">
      <span className="min-w-14 text-[13px] font-medium">{label}</span>
      <Leader />
      <span className="text-right font-mono text-[12px] tracking-[.05em] text-ink">{value}</span>
      {sub && <span className="font-mono text-[10px] tracking-[.05em] text-dim">({sub})</span>}
    </div>
  )
}

export const MagSec = ({
  tag,
  title,
  note,
  id,
  children,
}: {
  tag?: string
  title: string
  note?: string | undefined
  id?: string
  children: ReactNode
}) => (
  <section id={id} className="pt-13">
    <div className="mb-[22px] flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-ink pb-3">
      {tag && <span className="bg-ink px-2.5 py-1 font-mono text-[11px] tracking-[.22em] text-paper">{tag}</span>}
      <h2 className="text-[26px] font-semibold tracking-[.06em] text-ink">{title}</h2>
      {note && <span className="ml-auto font-mono text-[10px] tracking-[.12em] text-dim">{note}</span>}
    </div>
    {children}
  </section>
)

export const SpecRow = ({ label, note, value, strong }: { label: string; note?: string; value: ReactNode; strong?: boolean }) => (
  <div className="flex items-baseline gap-3.5 border-b border-line py-[11px]">
    <span className="min-w-24 text-[15px] font-medium text-ink">{label}</span>
    {note && <span className="text-[12.5px] text-dim">{note}</span>}
    <Leader />
    <span className={strong ? 'font-mono text-[15px] tracking-[.05em] text-wine-ink' : 'font-mono text-[13px] tracking-[.05em] text-ink'}>
      {value}
    </span>
  </div>
)

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block">
    <span className="mb-1.5 block text-[12px] tracking-[.06em] text-dim">{label}</span>
    {children}
  </label>
)

export const specInput =
  'w-full border border-line bg-card px-3 py-2.5 text-[14px] text-ink outline-none focus:border-wine focus:ring-[3px] focus:ring-wine-dim disabled:bg-deep disabled:text-dim'

const pillClass = (kind: 'primary' | 'ghost') =>
  kind === 'primary'
    ? 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border border-wine bg-wine px-[18px] py-2.5 text-[14px] font-medium tracking-[.02em] text-cream shadow-e1 transition-opacity hover:opacity-90'
    : 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent px-[18px] py-2.5 text-[14px] font-medium tracking-[.02em] text-wine-ink hover:bg-wine-dim/40'

export const PillLink = ({ href, kind, children }: { href: string; kind: 'primary' | 'ghost'; children: ReactNode }) => (
  <a href={href} className={pillClass(kind)}>
    {children}
  </a>
)

export const PillBtn = ({ children, full, type, onClick }: { children: ReactNode; full?: boolean; type?: 'submit' | 'button'; onClick?: () => void }) => (
  <button type={type ?? 'submit'} onClick={onClick} className={`${pillClass('primary')} ${full ? 'w-full' : ''}`}>
    {children}
  </button>
)

/* ── Modal ── */

export function Modal({ open, onClose, title, wide, children }: { open: boolean; onClose: () => void; title: string; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40" onClick={onClose}>
      <div className={`mx-4 w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} border border-ink bg-paper p-6 shadow-e1`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-baseline justify-between border-b border-ink pb-3">
          <h3 className="text-[20px] font-semibold text-ink">{title}</h3>
          <button type="button" onClick={onClose} className="text-[18px] text-dim hover:text-ink">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/* ── Paginator ── */

export function usePagination<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(0)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safeP = Math.min(page, totalPages - 1)
  if (safeP !== page) setPage(safeP)
  const paged = useMemo(() => items.slice(safeP * pageSize, (safeP + 1) * pageSize), [items, safeP, pageSize])
  return { page: safeP, totalPages, paged, setPage, total: items.length } as const
}

export function Paginator({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-center gap-3 pt-5 pb-2">
      <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}
        className="font-mono text-[11px] tracking-[.12em] text-dim enabled:hover:text-ink disabled:opacity-30">
        ‹ 上页
      </button>
      <span className="font-mono text-[10.5px] tracking-[.1em] text-dim">
        {page + 1} / {totalPages}
      </span>
      <button type="button" disabled={page >= totalPages - 1} onClick={() => onPage(page + 1)}
        className="font-mono text-[11px] tracking-[.12em] text-dim enabled:hover:text-ink disabled:opacity-30">
        下页 ›
      </button>
    </div>
  )
}

/* ── TabBar ── */

export function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string; count?: number }[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex gap-0 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={
            active === t.key
              ? 'border-b-2 border-wine px-4 py-2.5 text-[13px] font-medium text-wine-ink'
              : 'border-b-2 border-transparent px-4 py-2.5 text-[13px] text-dim hover:text-ink'
          }
        >
          {t.label}
          {t.count != null && (
            <span className="ml-1.5 font-mono text-[10px] tracking-[.08em] text-dim">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/* ── Global loading bar ── */

let _loadingCount = 0
const _listeners = new Set<() => void>()
const notify = () => _listeners.forEach((fn) => fn())

export function startLoading() { _loadingCount++; notify() }
export function stopLoading() { _loadingCount = Math.max(0, _loadingCount - 1); notify() }

function LoadingBar() {
  const loading = useSyncExternalStore(
    useCallback((cb: () => void) => { _listeners.add(cb); return () => _listeners.delete(cb) }, []),
    () => _loadingCount > 0,
  )
  if (!loading) return null
  return (
    <div className="fixed inset-x-0 top-0 z-[100] h-[2px] overflow-hidden bg-wine-dim">
      <div className="h-full w-1/3 animate-[slide_1s_ease-in-out_infinite] bg-wine" style={{ animation: 'slide 1s ease-in-out infinite' }} />
      <style>{`@keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }`}</style>
    </div>
  )
}

/* ── Skeleton ── */

export function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="animate-pulse pt-10 space-y-4">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 rounded bg-deep" style={{ width: `${70 + (i % 3) * 10}%` }} />
      ))}
    </div>
  )
}
