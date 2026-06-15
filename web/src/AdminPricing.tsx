import { useCallback, useEffect, useState } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import BooksTab from './pricing/BooksTab'
import ModesTab from './pricing/ModesTab'
import PapersTab from './pricing/PapersTab'
import QuotesTab from './pricing/QuotesTab'
import SizesTab from './pricing/SizesTab'
import type {
  BookProductDto,
  ComboDto,
  FinishingDto,
  ModeDto,
  PaperDto,
  PrinterDto,
  QuoteDto,
  SizeDto,
} from './pricing/types'
import { MagSec, Skeleton, TabBar } from './spec'

const TABS = [
  { key: 'quotes', label: '报价' },
  { key: 'papers', label: '纸张' },
  { key: 'modes', label: '模式' },
  { key: 'sizes', label: '尺寸' },
  { key: 'books', label: '册子' },
] as const

type TabKey = (typeof TABS)[number]['key']

function PricingBody() {
  const [tab, setTab] = useState<TabKey>('quotes')
  const [quotes, setQuotes] = useState<QuoteDto[] | null>(null)
  const [combos, setCombos] = useState<ComboDto[] | null>(null)
  const [modes, setModes] = useState<ModeDto[] | null>(null)
  const [papers, setPapers] = useState<PaperDto[] | null>(null)
  const [sizes, setSizes] = useState<SizeDto[] | null>(null)
  const [printers, setPrinters] = useState<PrinterDto[] | null>(null)
  const [books, setBooks] = useState<BookProductDto[] | null>(null)
  const [finishings, setFinishings] = useState<FinishingDto[] | null>(null)

  const reload = useCallback(() => {
    void Promise.all([
      send<QuoteDto[]>('GET', '/api/admin/pricing/quotes').then((r) => r.ok && setQuotes(r.data)),
      send<ComboDto[]>('GET', '/api/pricing/combos').then((r) => r.ok && setCombos(r.data)),
      send<ModeDto[]>('GET', '/api/pricing/modes').then((r) => r.ok && setModes(r.data)),
      send<PaperDto[]>('GET', '/api/pricing/papers').then((r) => r.ok && setPapers(r.data)),
      send<SizeDto[]>('GET', '/api/pricing/sizes').then((r) => r.ok && setSizes(r.data)),
      send<PrinterDto[]>('GET', '/api/equipment').then((r) => r.ok && setPrinters(r.data)),
      send<BookProductDto[]>('GET', '/api/pricing/books').then((r) => r.ok && setBooks(r.data)),
      send<FinishingDto[]>('GET', '/api/pricing/finishings').then((r) => r.ok && setFinishings(r.data)),
    ])
  }, [])
  useEffect(reload, [reload])

  if (!quotes || !combos || !modes || !papers || !sizes || !printers || !books || !finishings) {
    return <Skeleton />
  }

  const counts: Record<TabKey, number> = {
    quotes: quotes.length,
    papers: papers.filter((p) => p.archived === 0).length,
    modes: modes.filter((m) => m.archived === 0).length,
    sizes: sizes.length,
    books: books.filter((b) => b.archived === 0).length,
  }

  const tabsWithCounts = TABS.map((t) => ({ ...t, count: counts[t.key] }))

  return (
    <MagSec tag="PRICE" title="价目管理" note="CRUD · MATRIX · EXPORT">
      <TabBar tabs={tabsWithCounts} active={tab} onChange={(k) => setTab(k as TabKey)} />

      {tab === 'quotes' && (
        <QuotesTab quotes={quotes} combos={combos} modes={modes} papers={papers} sizes={sizes} onChanged={reload} />
      )}
      {tab === 'papers' && (
        <PapersTab papers={papers} sizes={sizes} onChanged={reload} />
      )}
      {tab === 'modes' && (
        <ModesTab modes={modes} sizes={sizes} printers={printers} onChanged={reload} />
      )}
      {tab === 'sizes' && (
        <SizesTab sizes={sizes} onChanged={reload} />
      )}
      {tab === 'books' && (
        <BooksTab books={books} finishings={finishings} papers={papers} sizes={sizes} onChanged={reload} />
      )}
    </MagSec>
  )
}

export default function AdminPricing() {
  return <AdminGate>{() => <PricingBody />}</AdminGate>
}
