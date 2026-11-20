/**
 * "What is this conversation at": one short line for a sidebar row, taken from
 * the agent's last reply. No model call: the first sentence or two, with the
 * markdown taken out, cut at a word at most `max` characters long.
 */
export const NOW_MAX = 90

/** Markdown and decoration out, one line of plain words. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The line for a reply, or '' when there is nothing worth showing. */
export function chatNow(reply: string, max = NOW_MAX): string {
  // The first paragraph that has words in it: a reply that opens with a code
  // block or a heading alone should not leave the row blank.
  const paragraphs = reply
    .split(/\n\s*\n/)
    .map(plain)
    .filter(Boolean)
  const first = paragraphs.find((p) => p.length >= 20) ?? paragraphs[0] ?? ''
  if (!first) return ''
  // "Fixed." alone says nothing: add sentences until there is something to read.
  const sentences = first.split(/(?<=[.!?])\s+/)
  let line = ''
  for (const s of sentences) {
    line = (line ? `${line} ${s.trim()}` : s.trim()).trim()
    if (line.length >= 30) break
  }
  if (line.length <= max) return line.replace(/[.]$/, '')
  const cut = line.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/**
 * The live line while a turn runs: what the agent is doing, in words. The raw command
 * ("./scripts/build-app.sh 2>&1 | tail -1") told nobody anything. In order: the step's
 * own description ("Build the app", which Claude Code writes for each command), else
 * the agent's latest sentence this turn ("Merging to main"), else a plain verb.
 */
export type LiveEntry =
  | { kind: 'say'; text: string }
  | { kind: 'tool'; verb: string; about?: string; target?: string }
  | { kind: 'think' }
  | { kind: 'user' }

/** The last sentence of what the agent said: its "about to" line. */
function lastSentence(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const flat = (paragraphs[paragraphs.length - 1] ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = flat.split(/(?<=[.!?])\s+/).filter(Boolean)
  return (sentences[sentences.length - 1] ?? '').replace(/[:.]$/, '').trim()
}

function cut(s: string, max = NOW_MAX): string {
  if (s.length <= max) return s
  const c = s.slice(0, max - 1)
  const at = c.lastIndexOf(' ')
  return `${(at > max * 0.6 ? c.slice(0, at) : c).replace(/[\s,;:.-]+$/, '')}…`
}

function plainStep(verb: string, target?: string): string {
  if (/^terminal$|^bash$|^shell$/i.test(verb)) return 'Running a command'
  if (/ing$/i.test(verb)) return target ? `${verb} ${target}` : verb
  return 'Working'
}

export function liveLine(entries: LiveEntry[]): string {
  // Only this turn: from the last thing the person said.
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].kind === 'user') {
      start = i + 1
      break
    }
  const turn = entries.slice(start)
  const last = turn[turn.length - 1]
  if (!last) return 'Reading what you asked'
  if (last.kind === 'tool' && last.about) return cut(last.about.replace(/\s+/g, ' ').trim())
  if (last.kind === 'say') {
    const s = lastSentence(last.text)
    if (s) return cut(s)
  }
  // A step with no words of its own: the agent's latest sentence this turn says what for.
  for (let i = turn.length - 1; i >= 0; i--) {
    const e = turn[i]
    if (e.kind === 'say') {
      const s = lastSentence(e.text)
      if (s) return cut(s)
    }
  }
  if (last.kind === 'tool') return plainStep(last.verb, last.target)
  return 'Thinking'
}
