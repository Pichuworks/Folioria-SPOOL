export interface QuoteDto {
  mode_id: number
  paper_id: number
  size_key: string
  total_c: number
  auto_sell_c: number
  sell_c: number
  source: string
  flag: 'auto' | 'manual' | 'below_margin' | 'LOSS' | 'forced'
  total_display: string
  auto_display: string
  sell_display: string
}

export interface ComboDto {
  id: number
  mode_id: number
  paper_id: number
  archived: number
  prices: Array<{ combo_id: number; size_key: string; sell_c: number | null; internal_sell_c: number | null }>
}

export interface ModeDto {
  id: number
  name: string
  printer_id: number
  ink_type: string
  pricing_mode: string
  ink_price_c: number
  ml_per_batch: number | null
  yield_sheets: number
  ref_size: string
  max_size: string
  duplex: number
  color_class: string | null
  archived: number
}

export interface PaperDto {
  id: number
  name: string
  category: string | null
  gsm: number | null
  supplier: string | null
  archived: number
  size_costs: Array<{ paper_id: number; size_key: string; pack_price_c: number; pack_count: number }>
}

export interface SizeDto {
  key: string
  label: string
  area: number
  sort: number
  width_mm: number | null
  height_mm: number | null
}

export interface PrinterDto {
  id: number
  code: string
}

export interface BookComponentRow {
  id: number
  book_id: number
  role: string
  paper_id: number
  size_key: string
  color_class: string
  duplex: number
  sort: number
  archived: number
}

export interface BookProductDto {
  id: number
  name: string
  archived: number
  components: BookComponentRow[]
  finishing_ids: number[]
}

export interface FinishingDto {
  id: number
  name: string
  pricing: 'per_book' | 'per_page' | 'per_area'
  price_c: number
  archived: number
}

export const FLAG_STYLE: Record<QuoteDto['flag'], { label: string; cls: string }> = {
  auto: { label: 'AUTO', cls: 'text-dim' },
  manual: { label: '手动', cls: 'text-ink' },
  below_margin: { label: '低毛利', cls: 'text-warn' },
  LOSS: { label: '亏本', cls: 'text-wine-ink' },
  forced: { label: 'FORCED', cls: 'text-dim' },
}

export const FLAG_BG: Record<string, string> = {
  auto: '',
  manual: 'bg-cream/30',
  below_margin: 'bg-warn/10',
  LOSS: 'bg-wine-dim/60',
  forced: 'bg-deep/50',
}

export const actionBtn = 'font-mono text-[10px] tracking-[.14em] hover:opacity-70'

export const FILTER_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'manual', label: '手动' },
  { key: 'below_margin', label: '低毛利' },
  { key: 'LOSS', label: '亏本' },
  { key: 'auto', label: '自动' },
] as const
