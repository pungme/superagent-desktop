/**
 * @-mentions shown as pills in the composer.
 *
 * The composer is a plain textarea, and a textarea cannot draw a pill around
 * part of its own text — and a picked folder dropped its whole absolute path in
 * there, `@/Users/me/code/project/`, which read as a wall of path in the middle
 * of a sentence. So a finished mention is held in the text as a short token
 * (`@project`), the full path is remembered beside it, and the path goes back
 * in only when the message is sent. The pill itself is drawn by a layer that
 * lays out exactly the same characters behind the textarea, so the caret and
 * the drawing never disagree about where anything is.
 */

/** token (without the @) → the full path it stands for. */
export type MentionMap = Map<string, string>

const isAbsolute = (p: string): boolean => /^[~/]/.test(p)

/**
 * The short name a picked path is shown as: its last segment, or — when a
 * different path already owns that name — enough parent segments to tell them
 * apart. A path inside this project is already short and stays as it is.
 */
export function tokenFor(path: string, map: MentionMap): string {
  if (!isAbsolute(path)) return path
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  for (let n = 1; n <= parts.length; n++) {
    const candidate = parts.slice(-n).join('/')
    const owner = map.get(candidate)
    if (owner === undefined || owner === path) return candidate
  }
  return path
}

/** Remember a picked path under its token, and return the token. */
export function registerMention(path: string, map: MentionMap): string {
  const token = tokenFor(path, map)
  map.set(token, path)
  return token
}

/**
 * Turn every finished absolute @mention — one already followed by whitespace,
 * so not the one still being typed or drilled into — into its short token.
 * The caret moves with the text it was after.
 */
export function compactMentions(
  text: string,
  caret: number,
  map: MentionMap
): { text: string; caret: number } {
  let out = ''
  let last = 0
  let moved = caret
  const re = /(^|\s)@([~/]\S*)(?=\s)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const path = m[2]
    const start = m.index + m[1].length + 1 // first character of the path
    const token = registerMention(path, map)
    out += text.slice(last, start) + token
    last = start + path.length
    if (last <= caret) moved -= path.length - token.length
  }
  if (last === 0) return { text, caret }
  return { text: out + text.slice(last), caret: moved }
}

// A token, with any punctuation that follows it kept out of the lookup:
// "see @project, then…" still finds `project`.
const TOKEN = /(^|\s)@(\S+?)([.,;:!?)\]]*)(?=\s|$)/g

/** Put each token's full path back, for the message that is actually sent. */
export function expandMentions(text: string, map: MentionMap): string {
  if (map.size === 0) return text
  return text.replace(TOKEN, (whole, pre: string, token: string, tail: string) => {
    const path = map.get(token)
    return path === undefined ? whole : `${pre}@${path}${tail}`
  })
}

export interface PillSegment {
  text: string
  pill: boolean
}

/** The text cut into plain runs and pills — same characters, in order. */
export function pillSegments(text: string, map: MentionMap): PillSegment[] {
  const out: PillSegment[] = []
  let last = 0
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    if (!map.has(m[2])) continue
    const start = m.index + m[1].length
    const end = start + 1 + m[2].length
    if (start > last) out.push({ text: text.slice(last, start), pill: false })
    out.push({ text: text.slice(start, end), pill: true })
    last = end
  }
  if (last < text.length) out.push({ text: text.slice(last), pill: false })
  return out
}

/**
 * The whole pill that ends right at the caret, if there is one — so Backspace
 * removes it in one go instead of leaving a half-token that is no longer a
 * mention of anything.
 */
export function pillBefore(text: string, caret: number, map: MentionMap): number | null {
  const m = /(^|\s)@(\S+)$/.exec(text.slice(0, caret))
  if (!m || !map.has(m[2])) return null
  return m.index + m[1].length
}
