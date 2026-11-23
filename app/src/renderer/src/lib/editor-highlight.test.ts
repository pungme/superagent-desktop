import { describe, expect, it } from 'vitest'
import { highlightFile, highlightMarkdown, languageLabel } from './editor-highlight'

// The editor's caret lines up only if the coloured layer shows exactly the text.
const visible = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

const DOC = `# WePush: How we build in 2026
*Tech & Product Vision, draft by pung*

---

## 1. Everything has changed

In 2026, writing software is **no longer** the hard part. Use \`code\` and _em_ and ~~old~~.
See [the site](https://example.com "title") or <https://x.y/z>. Escaped \\*star\\* and a < b & c > d.

- our creators and brands
  1. nested <b>html</b>
- [x] done task
> a quote with **bold**

| | Revenue per employee |
|---|---|
| Classic software company | $0.2M |

\`\`\`ts
const a = '<div>' // **not bold**
\`\`\`
<!-- a comment -->
Unclosed **bold and \`tick and [link( and *star
`

describe('editor highlight', () => {
  it('keeps Markdown text exactly', () => {
    expect(visible(highlightMarkdown(DOC))).toBe(DOC)
  })

  it('keeps code text exactly', () => {
    const src = "const x: Array<number> = [1, 2] // a < b && 'c'\nfunction f() { return `${x}` }\n"
    expect(visible(highlightFile(src, 'ts'))).toBe(src)
    expect(visible(highlightFile('<a href="x">&amp;</a>', 'html'))).toBe('<a href="x">&amp;</a>')
    expect(visible(highlightFile('plain <text>', 'txt'))).toBe('plain <text>')
  })

  it('marks Markdown structure', () => {
    const html = highlightMarkdown('## Title\n- item **b**')
    expect(html).toContain('mde-h2')
    expect(html).toContain('mde-bullet')
    expect(html).toContain('mde-strong')
  })

  it('names languages', () => {
    expect(languageLabel('md')).toBe('Markdown')
    expect(languageLabel('tsx')).toBe('TypeScript')
    expect(languageLabel('txt')).toBe('Plain Text')
  })
})
