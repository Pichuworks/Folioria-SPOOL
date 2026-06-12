import { type ReactNode } from 'react'

/* Asagaya modern·规格书（Specimen）家具：2px 墨线节头 / 点线规格行 / 直角控件，配色同 eri */

export const Leader = () => <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />

export const SpecSec = ({
  n,
  title,
  note,
  children,
}: {
  n: string
  title: string
  note?: string
  children: ReactNode
}) => (
  <section>
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 border-t-2 border-ink pt-3">
      <div className="flex items-baseline gap-3.5">
        <span className="font-mono text-[12px] text-wine-ink">{n}</span>
        <h2 className="text-[22px] font-semibold text-ink">{title}</h2>
      </div>
      {note && <span className="font-mono text-[10.5px] tracking-[.1em] text-dim">{note}</span>}
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

export const PillBtn = ({ children, full }: { children: ReactNode; full?: boolean }) => (
  <button
    type="submit"
    className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border border-wine bg-wine px-[18px] py-2.5 text-[14px] font-medium tracking-[.02em] text-cream shadow-e1 transition-opacity hover:opacity-90 ${full ? 'w-full' : ''}`}
  >
    {children}
  </button>
)
