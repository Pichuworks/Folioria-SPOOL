import { Marked, Renderer } from 'marked'

const renderer = new Renderer()
renderer.html = () => ''
const origLink = renderer.link
renderer.link = function (token) {
  if (/^\s*javascript:/i.test(token.href)) return token.text
  return origLink.call(this, token)
}

const marked = new Marked({ renderer })

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string
  return html.replace(/<[^>]*\bon\w+\s*=/gi, '<span data-sanitized ')
}
