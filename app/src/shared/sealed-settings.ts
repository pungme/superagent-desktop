/**
 * The settings of computer use, kept where an agent's shell cannot rewrite
 * them.
 *
 * They used to be plain rows in the app's database, which any process of the
 * user's can write: "computer use on, no app kept out, every app always
 * allowed" took one sqlite3 command and the next restart. They are one sealed
 * blob now, encrypted with a key macOS gives only to Superagent. A blob that
 * does not open is treated as no settings at all, which is everything off.
 */

export interface Seal {
  /** The text a blob holds, or null when it does not open. */
  open: (blob: string) => string | null
  close: (text: string) => string
}

/**
 * The settings to start from. `blob`: the sealed row, if there is one.
 * `legacy`: the plain rows of an earlier version, read once when there is no
 * blob yet. Only what makes computer use MORE careful is carried over from
 * them (the apps to stay out of, look-only apps, asking before each step,
 * showing only allowed apps): those rows could have been written by anyone,
 * so "on" and "always allow" are not taken from them. The user turns computer
 * use on again, once.
 */
export function loadSealed(
  blob: string | null,
  legacy: (key: string) => string | null,
  seal: Seal
): Record<string, string> {
  if (blob) {
    try {
      const text = seal.open(blob)
      const parsed: unknown = text ? JSON.parse(text) : null
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return Object.fromEntries(
        Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string')
      )
    } catch {
      return {}
    }
  }
  const out: Record<string, string> = {}
  const denied = legacy('computer.denied')
  if (denied && isArray(denied)) out['computer.denied'] = denied
  for (const key of ['computer.steps', 'computer.focused'])
    if (legacy(key) === '1') out[key] = '1'
  try {
    const rules = JSON.parse(legacy('computer.rules') || '[]') as { level?: unknown }[]
    const careful = Array.isArray(rules) ? rules.filter((r) => r && r.level === 'look') : []
    if (careful.length) out['computer.rules'] = JSON.stringify(careful)
  } catch {
    // not rules: nothing to carry over
  }
  return out
}

function isArray(json: string): boolean {
  try {
    return Array.isArray(JSON.parse(json))
  } catch {
    return false
  }
}
