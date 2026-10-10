/** The `/loop` skill's own mechanical reminder, appended verbatim to every
 *  round's user message — "(/loop, self-paced: …)" or "(/loop 5m: …)". Split
 *  off the trailing parenthetical so it renders as a note, not as part of
 *  what the user actually typed. */
export function splitLoopNote(text: string): { main: string; note: string | null } {
  const m = /\n\n(\(\/loop\b[\s\S]*\))\s*$/.exec(text)
  if (!m) return { main: text, note: null }
  return { main: text.slice(0, m.index).trimEnd(), note: m[1] }
}

/**
 * What to call a round of a loop where the instructions used to be shown: the
 * note is for the agent, a paragraph the user never wrote and need not read.
 */
export function loopLabel(note: string): string {
  const every = /^\(\/loop\s+(\d+\s*[smhd])\b/.exec(note)
  return every ? `Loop · every ${every[1].replace(/\s+/g, '')}` : 'Loop'
}
