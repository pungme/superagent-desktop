/**
 * Which project someone means by what they called it. People say "wepush" for
 * "wepush-portal", or half a name; an exact name wins, then one that starts
 * with it, then one that contains it. More than one at the same level is not
 * guessed at: they are all handed back to be asked about.
 */
export function findProject<T extends { name: string }>(
  projects: T[],
  said: string
): { match: T | null; candidates: T[] } {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s_\-.]+/g, '')
  const q = norm(said)
  if (!q) return { match: null, candidates: [] }
  const levels = [
    (n: string) => n === q,
    (n: string) => n.startsWith(q),
    (n: string) => n.includes(q)
  ]
  for (const fits of levels) {
    const found = projects.filter((p) => fits(norm(p.name)))
    if (found.length === 1) return { match: found[0], candidates: found }
    if (found.length > 1) return { match: null, candidates: found }
  }
  return { match: null, candidates: [] }
}
