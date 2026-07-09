import { useState } from 'react'
import AdminGate from './AdminGate'
import { send } from './api'
import CostTableTab from './pricing/CostTableTab'
import FinishingsTab from './pricing/FinishingsTab'
import ModesTab from './pricing/ModesTab'
import PapersTab from './pricing/PapersTab'
import QuotesTab from './pricing/QuotesTab'
import SizesTab from './pricing/SizesTab'
import type {
  ComboDto,
  FinishingDto,
  ModeDto,
  PaperDto,
  PrinterDto,
  QuoteDto,
  SizeDto,
} from './pricing/types'
import { MagSec, Skeleton, TabBar } from './spec'
import { useFetch } from './useFetch'

const TABS = [
  { key: 'quotes', label: '报价' },
  { key: 'costs', label: '成本表' },
  { key: 'papers', label: '纸张' },
  { key: 'modes', label: '模式' },
  { key: 'sizes', label: '尺寸' },
  { key: 'finishings', label: '工艺' },
] as const

type TabKey = (typeof TABS)[number]['key']

interface PricingData {
  quotes: QuoteDto[]
  combos: ComboDto[]
  modes: ModeDto[]
  papers: PaperDto[]
  sizes: SizeDto[]
  printers: PrinterDto[]
  finishings: FinishingDto[]
}

async function fetchPricingData(): Promise<PricingData> {
  const [quotes, combos, modes, papers, sizes, printers, finishings] = await Promise.all([
    send<QuoteDto[]>('GET', '/api/admin/pricing/quotes').then((r) => { if (!r.ok) throw r; return r.data }),
    send<ComboDto[]>('GET', '/api/pricing/combos').then((r) => { if (!r.ok) throw r; return r.data }),
    send<ModeDto[]>('GET', '/api/pricing/modes').then((r) => { if (!r.ok) throw r; return r.data }),
    send<PaperDto[]>('GET', '/api/pricing/papers').then((r) => { if (!r.ok) throw r; return r.data }),
    send<SizeDto[]>('GET', '/api/pricing/sizes').then((r) => { if (!r.ok) throw r; return r.data }),
    send<PrinterDto[]>('GET', '/api/equipment').then((r) => { if (!r.ok) throw r; return r.data }),
    send<FinishingDto[]>('GET', '/api/pricing/finishings').then((r) => { if (!r.ok) throw r; return r.data }),
  ])
  return { quotes, combos, modes, papers, sizes, printers, finishings }
}

function PricingBody() {
  const [tab, setTab] = useState<TabKey>('quotes')
  const { data, error, reload } = useFetch(fetchPricingData)

  if (error) return <p className="p-8 text-[13px] text-wine-ink">定价数据加载失败，请刷新重试。</p>
  if (!data) return <Skeleton />

  const { quotes, combos, modes, papers, sizes, printers, finishings } = data

  const counts: Record<TabKey, number> = {
    quotes: quotes.length,
    costs: quotes.length,
    papers: papers.filter((p) => p.archived === 0).length,
    modes: modes.filter((m) => m.archived === 0).length,
    sizes: sizes.length,
    finishings: finishings.filter((f) => f.archived === 0).length,
  }

  const tabsWithCounts = TABS.map((t) => ({ ...t, count: counts[t.key] }))

  return (
    <MagSec title="价目管理">
      <TabBar tabs={tabsWithCounts} active={tab} onChange={(k) => setTab(k as TabKey)} />

      {tab === 'quotes' && (
        <QuotesTab quotes={quotes} combos={combos} modes={modes} papers={papers} sizes={sizes} onChanged={reload} />
      )}
      {tab === 'costs' && (
        <CostTableTab quotes={quotes} modes={modes} papers={papers} />
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
      {tab === 'finishings' && (
        <FinishingsTab finishings={finishings} onChanged={reload} />
      )}
    </MagSec>
  )
}

export default function AdminPricing() {
  return <AdminGate>{() => <PricingBody />}</AdminGate>
}
