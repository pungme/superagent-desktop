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
 * Chats that fit a description, best first.
 *
 * Words that name a project keep the list to that project: the one whose name
 * fits the most of them ("wepush portal" is wepush-portal, not wepush). The
 * rest of the words are the topic, looked for in each chat's title and in what
 * was said in it. When no chat of the project fits the topic, its chats are
 * offered anyway, most recent first, rather than nothing. With no project
 * named, a chat has to fit the topic. Ties go to the one used most recently.
 */
export function rankChats<T extends FindableChat>(chats: T[], said: string, limit = 8): T[] {
  const words = searchWords(said)
  if (!words.length) return []
  const inProject = (c: T): string[] => {
    const project = squash(c.projectName)
    return words.filter((w) => project.includes(squash(w)))
  }
  const most = Math.max(0, ...chats.map((c) => inProject(c).length))
  const pool = most > 0 ? chats.filter((c) => inProject(c).length === most) : chats
  const scored = pool.map((c) => {
    const title = squash(c.title)
    const named = new Set(most > 0 ? inProject(c) : [])
    let score = 0
    let hits = 0
    for (const w of words) {
      if (named.has(w)) continue
      const inTitle = title.includes(squash(w))
      const inSaid = !!c.saidWords?.includes(w)
      if (inTitle) score += 3
      if (inSaid) score += 1
      if (inTitle || inSaid) hits++
    }
    return { c, score, hits }
  })
  const fitting = scored.filter((s) => s.hits > 0)
  // A project was named and nothing in it fits the rest: its chats, as they are.
  const kept = fitting.length ? fitting : most > 0 ? scored : []
  return kept
    .sort((a, b) => b.hits - a.hits || b.score - a.score || b.c.updatedAt - a.c.updatedAt)
    .slice(0, limit)
    .map((s) => s.c)
}
