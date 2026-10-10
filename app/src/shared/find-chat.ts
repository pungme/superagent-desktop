/**
 * Which conversation someone means by how they describe it: "the wepush chat
 * about e2e testing". Words are looked for in the chat's title, in its
 * project's name and in what was said in it; the title counts most.
 */

export interface FindableChat {
  id: string
  title: string
  projectId: string
  projectName: string
  updatedAt: number
  /** Query words found in what was said in the chat (from a search of its messages). */
  saidWords?: string[]
  /** A line from it that matched, to show beside it. */
  snippet?: string
}

/** Words that say nothing about which chat: the ones people wrap a request in. */
const FILLER = new Set(
  (
    'a an the this that these those one ones it my our your of in on at for to from with about into ' +
    'and or go open show take me us please hey hi chat chats conversation conversations session sessions ' +
    'project projects thread where when was were is are i we you did do talked talking discussed regarding'
  ).split(' ')
)

/** The words of a description that could tell one chat from another. */
export function searchWords(said: string): string[] {
  const words = said
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !FILLER.has(w))
  return [...new Set(words)]
}

const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Chats that fit a description, best first. A chat has to match at least one
 * word; when the description names a project, chats of other projects are
 * left out. Ties go to the one used most recently.
 */
export function rankChats<T extends FindableChat>(chats: T[], said: string, limit = 8): T[] {
  const words = searchWords(said)
  if (!words.length) return []
  const scored = chats
    .map((c) => {
      const title = squash(c.title)
      const project = squash(c.projectName)
      let score = 0
      let hits = 0
      for (const w of words) {
        const k = squash(w)
        const inTitle = title.includes(k)
        const inProject = project.includes(k)
        const inSaid = !!c.saidWords?.includes(w)
        if (inTitle) score += 3
        if (inProject) score += 2
        if (inSaid) score += 1
        if (inTitle || inProject || inSaid) hits++
      }
      // Only its project's name fitting is not a match: every chat there would be one.
      const more = words.some((w) => title.includes(squash(w)) || c.saidWords?.includes(w))
      const onlyProjectWords = words.every((w) => project.includes(squash(w)))
      return { c, score, hits, ok: hits > 0 && (more || onlyProjectWords) }
    })
    .filter((s) => s.ok)
  // A word that names a project keeps the list to that project.
  const named = new Set(
    scored
      .filter((s) => words.some((w) => squash(s.c.projectName).includes(squash(w))))
      .map((s) => s.c.projectId)
  )
  const kept = named.size ? scored.filter((s) => named.has(s.c.projectId)) : scored
  return kept
    .sort((a, b) => b.hits - a.hits || b.score - a.score || b.c.updatedAt - a.c.updatedAt)
    .slice(0, limit)
    .map((s) => s.c)
}
