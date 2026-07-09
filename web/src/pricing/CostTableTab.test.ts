import { describe, expect, it } from 'vitest'
import { buildCostRows } from './CostTableTab'
import type { ModeDto, PaperDto, QuoteDto } from './types'

const modes: ModeDto[] = [
  {
    id: 1,
    name: 'C850 黑白·单',
    printer_id: 1,
    ink_type: 'toner',
    pricing_mode: 'set',
    ink_price_c: 14000000,
    ml_per_batch: null,
    yield_sheets: 56000,
    ref_size: 'A4',
    max_size: 'SRA3',
    duplex: 0,
    color_class: 'bw',
    archived: 0,
  },
]

const papers: PaperDto[] = [
  {
    id: 1,
    name: '亚太森博 A4',
    category: null,
    gsm: 70,
    supplier: null,
    archived: 0,
    size_costs: [],
  },
]

const quotes: QuoteDto[] = [
  {
    mode_id: 1,
    paper_id: 1,
    size_key: 'A4',
    ink_c: 2500,
    paper_c: 317,
    total_c: 2817,
    auto_sell_c: 8537,
    sell_c: 700,
    source: 'manual',
    flag: 'LOSS',
    ink_display: '￥0.25',
    paper_display: '￥0.0317',
    total_display: '￥0.2817',
    auto_display: '￥0.8537',
    sell_display: '￥0.07',
    has_tiers: false,
  },
]

describe('buildCostRows', () => {
  it('maps quote cost fields into named display rows', () => {
    expect(buildCostRows(quotes, modes, papers)).toEqual([
      {
        id: '1:1:A4',
        modeName: 'C850 黑白·单',
        paperName: '亚太森博 A4',
        sizeKey: 'A4',
        inkDisplay: '￥0.25',
        paperDisplay: '￥0.0317',
        totalDisplay: '￥0.2817',
        autoDisplay: '￥0.8537',
        sellDisplay: '￥0.07',
        source: 'manual',
        flag: 'LOSS',
      },
    ])
  })
})
