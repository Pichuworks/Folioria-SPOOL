// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

// review M7：renderMarkdown 是 XSS 防护关键路径（剥原始 HTML / 过滤 javascript: / DOMPurify），此前零测试。
describe('renderMarkdown — XSS 防护', () => {
  it('剥离原始 <script> 标签', () => {
    const out = renderMarkdown('hello <script>alert(1)</script> world')
    expect(out).not.toMatch(/<script/i)
  })

  it('剥离原始 HTML 事件处理器（onerror 注入）', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('onerror')
    expect(out).not.toMatch(/<img/i)
  })

  it('javascript: 链接被中和（不渲染为可点 <a>，不含 javascript:）', () => {
    const out = renderMarkdown('[click](javascript:alert(1))')
    expect(out).not.toContain('javascript:')
    expect(out).not.toMatch(/<a[\s>]/i)
  })

  it('合法外链注入 rel="noopener noreferrer"', () => {
    const out = renderMarkdown('[x](https://example.com)')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('正常 markdown 仍渲染（粗体）', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>')
  })
})
