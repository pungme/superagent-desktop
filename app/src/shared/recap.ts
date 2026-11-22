/**
 * The conversation so far, for an agent that has no memory of it: a chat moved
 * to another agent, a session that could not be resumed, a copy of a chat.
 *
 * Within a budget, so the recap does not eat the new agent's context:
 *  - the first request, always: it is what the whole conversation is for;
 *  - then the most recent exchange, newest kept first, each message clipped;
 *  - what the agent did between messages, one line ("Steps: ran `npm test`,
 *    edited header.css"), so "it ran the tests and they failed" is not lost;
 *  - and a line saying how much in between was left out.
 * Speakers are "User" and "Assistant", never an agent's name: the log does not
 * say which agent wrote each reply.
 *
 * Pure, so the rules are tested without the database.
 */
export type RecapItem =
  | { kind: 'msg'; msg: { role: 'user' | 'assistant'; text: string; system?: boolean } }
  | { kind: 'tool'; tool: { name: string; detail?: string } }
  | { kind: 'diff'; diff: { file: string } }
  | { kind: string }

export const RECAP_BUDGET = 12_000
const CLIP = { user: 2_000, assistant: 1_500, steps: 400 }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function stepLabel(it: RecapItem): string | null {
  if (it.kind === 'tool' && 'tool' in it) {
    const d = oneLine(it.tool.detail ?? '')
    const name = it.tool.name
    if (name === 'Bash') return d ? `ran \`${clip(d, 80)}\`` : 'ran a command'
    if (/^(Edit|MultiEdit|Write)$/.test(name)) return d ? `edited ${clip(d, 60)}` : 'edited a file'
    if (/^(Read|Glob|Grep|LS)$/.test(name)) return d ? `read ${clip(d, 60)}` : 'read files'
    return d ? `${name} ${clip(d, 60)}` : name
  }
  if (it.kind === 'diff' && 'diff' in it) return `edited ${it.diff.file}`
  return null
}

/** The recap lines for these items, or '' when nothing was said. */
export function recapFrom(items: RecapItem[], budget = RECAP_BUDGET): string {
  // Messages, with the steps between them folded into one line each.
  const lines: { user: boolean; text: string }[] = []
  let steps: string[] = []
  const flush = (): void => {
    if (!steps.length) return
    const shown = steps.slice(0, 8)
    const more = steps.length - shown.length
    lines.push({
      user: false,
      text: clip(`Steps: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`, CLIP.steps)
    })
    steps = []
  }
  for (const it of items) {
    if (it.kind === 'msg' && 'msg' in it) {
      const m = it.msg
      if (m.system || !m.text?.trim()) continue
      flush()
      const user = m.role === 'user'
      lines.push({
        user,
        text: `${user ? 'User' : 'Assistant'}: ${clip(oneLine(m.text), user ? CLIP.user : CLIP.assistant)}`
      })
    } else {
      const s = stepLabel(it)
      if (s) steps.push(s)
    }
  }
  flush()
  if (!lines.some((l) => l.text.startsWith('User:') || l.text.startsWith('Assistant:'))) return ''

  const first = lines.findIndex((l) => l.user)
  const keepFirst = first >= 0 ? first : -1
  let used = keepFirst >= 0 ? lines[keepFirst].text.length : 0
  const tail: number[] = []
  for (let i = lines.length - 1; i > keepFirst; i--) {
    const n = lines[i].text.length + 1
    if (used + n > budget && tail.length > 0) break
    used += n
    tail.unshift(i)
  }
  const out: string[] = []
  if (keepFirst >= 0) out.push(lines[keepFirst].text)
  const start = tail.length ? tail[0] : lines.length
  const skipped = lines
    .slice(keepFirst + 1, start)
    .filter((l) => !l.text.startsWith('Steps:')).length
  if (skipped > 0) out.push(`[… ${skipped} earlier message${skipped === 1 ? '' : 's'} left out …]`)
  for (const i of tail) out.push(lines[i].text)
  return out.join('\n')
}
