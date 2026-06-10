export interface CurrencyDto {
  code: string
  symbol: string
  decimal_places: number
}

export interface PriceEntryDto {
  sell_c: number
  display: string
}

export interface OptionsDto {
  currency: CurrencyDto
  sizes: Array<{ key: string; label: string; sort: number }>
  modes: Array<{ id: number; name: string; duplex: boolean; max_size: string }>
  papers: Array<{ id: number; name: string }>
  options: Array<{ mode_id: number; paper_id: number; prices: Record<string, PriceEntryDto> }>
}

export interface QuoteDto {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  unit_price_c: number
  unit_display: string
  line_total: number
  line_total_display: string
  currency: string
}

export async function fetchOptions(): Promise<OptionsDto> {
  const res = await fetch('/api/calculator/options')
  if (!res.ok) throw new Error(`options failed: ${res.status}`)
  return (await res.json()) as OptionsDto
}

export async function fetchQuote(req: {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
}): Promise<QuoteDto | null> {
  const res = await fetch('/api/calculator/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`quote failed: ${res.status}`)
  return (await res.json()) as QuoteDto
}
