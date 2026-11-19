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
