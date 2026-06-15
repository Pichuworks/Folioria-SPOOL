import { type ReactNode } from 'react'

/* Asagaya modern·杂志语域 × eri 配色，全站统一壳：刊头 / 墨标签节头 / 点线行 / 直角控件 / 对折页码 */

export const Leader = () => <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />

export const Shell = ({ nav, center, right, children }: { nav: ReactNode; center: string; right?: ReactNode; children: ReactNode }) => (
  <div className="min-h-screen bg-paper text-ink">
    <div className="mx-auto max-w-[1200px] px-5 md:px-10">
      <Masthead nav={nav} />
      <main className="min-h-[60vh] pb-16">{children}</main>
      <Folio center={center} right={right} />
    </div>
  </div>
)

export const Masthead = ({ nav }: { nav: ReactNode }) => (
  <header className="flex flex-wrap items-end justify-between gap-x-[18px] gap-y-3 border-b border-ink pb-4 pt-[30px]">
    <a href="#/" className="flex items-end gap-5 text-ink">
      <span className="text-[44px] font-bold leading-none tracking-[.04em]">Folioria</span>
      <span className="pb-1">
        <span className="block text-[15px] font-medium tracking-[.08em]">枫光映刻</span>
        <span className="block font-garamond text-[13px] italic text-dim">Maplescape</span>
      </span>
    </a>
    <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 pb-1 text-[13px]">{nav}</nav>
  </header>
)

export const Folio = ({ center, right }: { center: string; right?: ReactNode }) => (
  <footer className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-ink pb-7 pt-3 font-mono text-[10.5px] tracking-[.14em] text-dim">
    <span>FOLIORIA · S.P.O.O.L.</span>
    <span>{center}</span>
    <span>{right ?? '© 2026 FOLIORIA'}</span>
  </footer>
)

export const MagSec = ({
  tag,
  title,
  note,
  id,
  children,
}: {
  tag: string
  title: string
  note?: string
  id?: string
  children: ReactNode
}) => (
  <section id={id} className="pt-13">
    <div className="mb-[22px] flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-ink pb-3">
      <span className="bg-ink px-2.5 py-1 font-mono text-[11px] tracking-[.22em] text-paper">{tag}</span>
      <h2 className="text-[26px] font-semibold text-ink">{title}</h2>
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

export const PillBtn = ({ children, full }: { children: ReactNode; full?: boolean }) => (
  <button type="submit" className={`${pillClass('primary')} ${full ? 'w-full' : ''}`}>
    {children}
  </button>
)
