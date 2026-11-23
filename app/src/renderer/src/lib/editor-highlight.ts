/**
 * Syntax colouring for the file editor. The editor draws this HTML in a layer
 * under a transparent textarea, so the one rule that matters: the visible text
 * of the output must equal the input exactly, character for character. Only
 * colour, weight and style change (never size), so the caret and selection
 * still line up with the glyphs underneath in a monospace font.
 */
import hljs from 'highlight.js/lib/core'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const span = (cls: string, html: string): string => `<span class="${cls}">${html}</span>`

/** Inline Markdown: `code`, **bold**, *em*, ~~strike~~, [links](url), <https://…>. */
function inline(text: string): string {
  let out = ''
  let i = 0
  // Each pattern is anchored at the current position; the first that matches wins.
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^(`+)([\s\S]*?[^`])\1(?!`)/, (m) => span('mde-code', esc(m[0]))],
    [
      /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/,
      (m) => span('mde-strong', span('mde-mark', m[1]) + inline(m[2]) + span('mde-mark', m[1]))
    ],
    [
      /^(\*|_)(?=[^\s*_])([\s\S]*?[^\s*_])\1(?![*_\w])/,
      (m) => span('mde-em', span('mde-mark', m[1]) + inline(m[2]) + span('mde-mark', m[1]))
    ],
    [
      /^~~(?=\S)([\s\S]*?\S)~~/,
      (m) => span('mde-strike', span('mde-mark', '~~') + inline(m[1]) + span('mde-mark', '~~'))
    ],
    [
      /^(!?\[)([^\]\n]*)(\]\()([^)\s]*)((?:\s+"[^"]*")?\))/,
      (m) =>
        span('mde-mark', esc(m[1])) +
        span('mde-link', inline(m[2])) +
        span('mde-mark', esc(m[3])) +
        span('mde-url', esc(m[4])) +
        span('mde-mark', esc(m[5]))
    ],
    [/^<https?:\/\/[^>\s]+>/, (m) => span('mde-url', esc(m[0]))],
    [/^<!--[\s\S]*?-->/, (m) => span('mde-dim', esc(m[0]))]
  ]
  outer: while (i < text.length) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      out += span('mde-mark', esc(text.slice(i, i + 2)))
      i += 2
      continue
    }
    if ('`*_~[!<'.includes(ch)) {
      const rest = text.slice(i)
      for (const [re, render] of rules) {
        const m = re.exec(rest)
        if (m) {
          out += render(m)
          i += m[0].length
          continue outer
        }
      }
    }
    out += esc(ch)
    i++
  }
  return out
}

/** Markdown, line by line (block syntax) with inline syntax inside each line. */
export function highlightMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    if (fence !== null) {
      const closes = new RegExp(
        `^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`
      ).test(line)
      out.push(span(closes ? 'mde-fence' : 'mde-codeblock', esc(line)))
      if (closes) fence = null
      continue
    }
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (open) {
      fence = open[1]
      out.push(span('mde-fence', esc(line)))
      continue
    }
    let m: RegExpExecArray | null
    if ((m = /^(\s{0,3}#{1,6})(\s.*|$)/.exec(line))) {
      const level = Math.min(m[1].trim().length, 3)
      out.push(span(`mde-h mde-h${level}`, span('mde-mark', esc(m[1])) + inline(m[2])))
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(span('mde-dim', esc(line)))
    } else if ((m = /^(\s*>+\s?)(.*)$/.exec(line))) {
      out.push(span('mde-quote', span('mde-mark', esc(m[1])) + inline(m[2])))
    } else if ((m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?(.*)$/.exec(line))) {
      out.push(
        esc(m[1]) +
          span('mde-bullet', esc(m[2])) +
          m[3] +
          (m[4] ? span('mde-task', esc(m[4])) : '') +
          inline(m[5])
      )
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      // Table row: dim the pipes and the |---|---| rule, keep cell text readable.
      if (/^[\s|:-]+$/.test(line)) out.push(span('mde-dim', esc(line)))
      else
        out.push(
          line
            .split('|')
            .map((cell) => inline(cell))
            .join(span('mde-dim', '|'))
        )
    } else {
      out.push(inline(line))
    }
  }
  return out.join('\n')
}

/** Above this size, colouring every keystroke costs more than it is worth. */
const MAX_HIGHLIGHT = 300_000

/** File extension → highlight.js language (only those Markdown.tsx registers). */
const LANG: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  py: 'python',
  sh: 'bash',
  zsh: 'bash',
  bash: 'bash',
  json: 'json',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  css: 'css',
  go: 'go',
  rs: 'rust',
  java: 'java',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml'
}

/** A friendly name for the footer. */
export function languageLabel(ext: string): string {
  if (ext === 'md' || ext === 'markdown') return 'Markdown'
  const names: Record<string, string> = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    bash: 'Shell',
    json: 'JSON',
    xml: ext === 'html' ? 'HTML' : 'XML',
    css: 'CSS',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    sql: 'SQL',
    yaml: 'YAML'
  }
  return names[LANG[ext]] ?? (ext === 'txt' ? 'Plain Text' : ext ? ext.toUpperCase() : 'Plain Text')
}

/** Highlighted HTML for a file's text, chosen by its extension. */
export function highlightFile(text: string, ext: string): string {
  if (text.length > MAX_HIGHLIGHT) return esc(text)
  if (ext === 'md' || ext === 'markdown') return highlightMarkdown(text)
  const lang = LANG[ext]
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
    } catch {
      /* fall through to plain */
    }
  }
  return esc(text)
}
