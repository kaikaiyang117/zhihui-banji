import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
})

export function renderAgentMarkdown(content) {
  const html = markdown.render(String(content || ''))
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
