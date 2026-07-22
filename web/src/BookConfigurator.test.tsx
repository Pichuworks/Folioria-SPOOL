// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BookConfigurator from './BookConfigurator'
import type { BookConfigDto } from './api'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMocks = vi.hoisted(() => ({
  fetchBookConfig: vi.fn(),
  fetchBookSpecQuote: vi.fn(),
  getBookConfigCache: vi.fn(),
}))

vi.mock('./api', () => apiMocks)

const config: BookConfigDto = {
  currency: { code: 'CNY', symbol: '¥', decimal_places: 2 },
  sizes: [{ key: 'A5', label: 'A5', area: 1, sort: 1, width_mm: 148, height_mm: 210 }],
  papers: [{
    id: 1,
    name: '测试纸',
    category: null,
    gsm: 80,
    variants: [{ size_key: 'A5', color_classes: ['bw', 'color'] }],
  }],
  finishings: { binding: [], addons: [] },
}

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.clearAllMocks()
})

describe('书册每本张数输入', () => {
  it('允许编辑时暂时清空，不会立即强制写回 1', async () => {
    apiMocks.getBookConfigCache.mockReturnValue(config)
    apiMocks.fetchBookConfig.mockResolvedValue(config)
    apiMocks.fetchBookSpecQuote.mockResolvedValue({ ok: false, status: 422, data: {} })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<BookConfigurator onAdd={vi.fn()} />))

    const sizeSelect = container.querySelector('select')
    expect(sizeSelect).not.toBeNull()
    await act(async () => {
      sizeSelect!.value = 'A5'
      sizeSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const sheetsInput = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="number"]'))
      .find((input) => input.closest('label')?.textContent?.includes('每本张数'))
    expect(sheetsInput?.value).toBe('20')

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(sheetsInput, '')
      sheetsInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(sheetsInput?.value).toBe('')
    expect(apiMocks.fetchBookSpecQuote).not.toHaveBeenCalled()

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(sheetsInput, '36')
      sheetsInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(sheetsInput?.value).toBe('36')
  })
})
