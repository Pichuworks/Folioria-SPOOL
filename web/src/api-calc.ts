import { send, swr, type CacheEntry, type CurrencyDto, type PriceEntryDto } from './api-core'

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
  base_unit_price_c?: number
  base_unit_display?: string
  unit_price_c: number
  unit_display: string
  line_total: number
  line_total_display: string
  currency: string
  finishings?: Array<{
    finishing_id: number
    name: string
    pricing: string
    price_c: number
    contribution_c: number
    contribution_display: string
  }>
}

export interface FinishingCatalogItem {
  id: number
  name: string
  pricing: string
  price_c: number
  category: string | null
  price_display: string
}

export interface FinishingCatalogDto {
  currency: CurrencyDto
  finishings: FinishingCatalogItem[]
}

let optionsEntry: CacheEntry<OptionsDto> | null = null
export const getOptionsCache = (): OptionsDto | null => optionsEntry?.data ?? null

export function fetchOptions(): Promise<OptionsDto> {
  return swr(optionsEntry, async () => {
    const res = await fetch('/api/calculator/options')
    if (!res.ok) throw new Error(`options failed: ${res.status}`)
    return (await res.json()) as OptionsDto
  }, (e) => { optionsEntry = e })
}

// ③⑤ 客户产品视图：按属性折叠的目录（机器不可见）
export interface ProductDto {
  category: string
  tech: string
  paper_id: number
  size_key: string
  duplex: boolean
  mode_id: number
  sell_c: number
  display: string
}
export interface ProductsDto {
  currency: CurrencyDto
  papers: Array<{ id: number; name: string }>
  sizes: Array<{ key: string; label: string; sort: number }>
  products: ProductDto[]
}
let productsEntry: CacheEntry<ProductsDto> | null = null
export const getProductsCache = (): ProductsDto | null => productsEntry?.data ?? null
export function fetchProducts(): Promise<ProductsDto> {
  return swr(productsEntry, async () => {
    const res = await fetch('/api/calculator/products')
    if (!res.ok) throw new Error(`products failed: ${res.status}`)
    return (await res.json()) as ProductsDto
  }, (e) => { productsEntry = e })
}

// ③⑤/D27 书册目录（机器对客户不可见）
export interface BookComponentDto {
  id: number
  role: 'cover' | 'inner' | 'insert'
  paper_id: number
  paper_name: string
  size_key: string
  size_label: string
  color_class: string
  duplex: boolean
}
export interface BookFinishingDto {
  id: number
  name: string
  pricing: 'per_book' | 'per_page' | 'per_area'
  price_c: number
  price_display: string
}
export interface BookCatalogItemDto {
  id: number
  name: string
  components: BookComponentDto[]
  finishings: BookFinishingDto[]
}
export interface BooksCatalogDto {
  currency: CurrencyDto
  books: BookCatalogItemDto[]
}
let booksEntry: CacheEntry<BooksCatalogDto> | null = null
export const getBooksCache = (): BooksCatalogDto | null => booksEntry?.data ?? null
export function fetchBooks(): Promise<BooksCatalogDto> {
  return swr(booksEntry, async () => {
    const res = await fetch('/api/calculator/books')
    if (!res.ok) throw new Error(`books failed: ${res.status}`)
    return (await res.json()) as BooksCatalogDto
  }, (e) => { booksEntry = e })
}

export interface BookQuoteDto {
  book_id: number
  name: string
  count: number
  unit_price_c: number
  unit_display: string
  line_total: number
  line_total_display: string
  components: Array<{ component_id: number; role: string; sheets_per_book: number; unit_sell_c: number; unit_display: string }>
  finishings: Array<{ finishing_id: number; name: string; pricing: string; contribution_c: number; contribution_display: string }>
}
/** 书册实时报价：客户填内页/插图张数 + 本数 → 出价（机器不可见）。422 → { error } */
export const fetchBookQuote = (body: {
  book_id: number
  count: number
  components?: Array<{ component_id: number; sheets_per_book: number }>
}) => send<BookQuoteDto & { error?: string }>('POST', '/api/calculator/book-quote', body)

// D36 自定义书册
export interface BookConfigPaper {
  id: number
  name: string
  category: string | null
  gsm: number | null
  available_sizes: string[]
  color_classes: string[]
}
export interface BookConfigFinishing {
  id: number
  name: string
  pricing: string
  price_c: number
  price_display: string
  category?: string | null
}
export interface BookConfigDto {
  currency: CurrencyDto
  sizes: Array<{ key: string; label: string; area: number; sort: number; width_mm: number | null; height_mm: number | null }>
  papers: BookConfigPaper[]
  finishings: {
    binding: BookConfigFinishing[]
    addons: BookConfigFinishing[]
  }
}
let bookConfigEntry: CacheEntry<BookConfigDto> | null = null
export const getBookConfigCache = (): BookConfigDto | null => bookConfigEntry?.data ?? null
export function fetchBookConfig(): Promise<BookConfigDto> {
  return swr(bookConfigEntry, async () => {
    const res = await fetch('/api/calculator/book-config')
    if (!res.ok) throw new Error(`book-config failed: ${res.status}`)
    return (await res.json()) as BookConfigDto
  }, (e) => { bookConfigEntry = e })
}

export interface BookSpecQuoteInput {
  count: number
  size_key: string
  components: Array<{
    role: 'cover' | 'inner' | 'insert'
    paper_id: number
    color_class: string
    duplex: number
    sheets_per_book?: number
  }>
  finishing_ids?: number[]
}
export type BookSpecQuoteDto = BookQuoteDto & { error?: string }
export const fetchBookSpecQuote = (body: BookSpecQuoteInput) =>
  send<BookSpecQuoteDto>('POST', '/api/calculator/book-spec-quote', body)

export async function fetchQuote(req: {
  mode_id: number
  paper_id: number
  size_key: string
  quantity: number
  finishing_ids?: number[]
}): Promise<QuoteDto | null> {
  const res = await fetch('/api/calculator/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spool-request': '1' },
    body: JSON.stringify(req),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`quote failed: ${res.status}`)
  return (await res.json()) as QuoteDto
}

export async function fetchFinishingCatalog(): Promise<FinishingCatalogDto | null> {
  const res = await fetch('/api/calculator/finishings')
  if (!res.ok) return null
  return (await res.json()) as FinishingCatalogDto
}
