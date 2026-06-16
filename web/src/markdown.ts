import { Marked, Renderer } from 'marked'

const renderer = new Renderer()
renderer.html = () => ''

const marked = new Marked({ renderer })

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string
  return html.replace(/<[^>]*\bon\w+\s*=/gi, '<span data-sanitized ')
}
