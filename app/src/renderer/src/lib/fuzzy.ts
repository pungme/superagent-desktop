/**
 * Subsequence fuzzy match: every character of the query must appear in the
 * target in the same order, not necessarily touching. "shot" matches
 * "Shotcaller" (a prefix run — scores highest) and also "the shot caller"
 * (scattered — still matches, ranks lower). No dependency: the rest of this
 * app's filtering (branch menu, @-mentions) is already plain substring
 * matching in `lib/`, so this stays a small, pure sibling rather than pulling
 * in a matching library for one screen.
 */
const WORD_BOUNDARY = /[\s\-_/.]/

export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = target.toLowerCase()
  let ti = 0
  let run = 0
  let score = 0
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti)
    if (idx === -1) return null
    const contiguous = idx === ti
    const boundary = idx === 0 || WORD_BOUNDARY.test(t[idx - 1])
    run = contiguous ? run + 1 : 1
    score += contiguous ? run * 3 : 1
    if (boundary) score += 6
    // A hit near the start of the target matters more than one buried deep in it.
    score += Math.max(0, 4 - idx * 0.1)
    ti = idx + 1
  }
  // Reward a query that accounts for most of the target — "shot" fully
  // explaining "Shot" outranks it explaining a fraction of "the shot caller".
  score += (q.length / t.length) * 6
  return score
}

/** Ranks `items` by fuzzy score against `text(item)`, best first. Everything
 *  matches an empty query, in its given order — the palette's "show
 *  everything" state before you start typing. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (!query.trim()) return [...items]
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = fuzzyScore(query, text(item))
    if (score !== null) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}
