import DOMPurify from 'dompurify'
import { Marked, Renderer } from 'marked'

const renderer = new Renderer()
renderer.html = () => ''
const origLink = renderer.link
renderer.link = function (token) {
  if (/^\s*javascript:/i.test(token.href)) return token.text
  const html = origLink.call(this, token)
  return html.replace('<a ', '<a rel="noopener noreferrer" ')
}

const marked = new Marked({ renderer })

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['rel'] })
}
