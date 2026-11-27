/**
 * A window and the phone can both write one conversation. The window holds a copy in
 * memory and saves it against the revision it read; when the Mac stored something the
 * window had not seen (the phone drove the chat), the save was refused with "Transcript
 * changed in another window" and saving stopped until the conversation was reopened.
 *
 * What the Mac adds is only ever new items at the end, so the two can be put together:
 * the stored items (the window's own version of any it also holds, since it may have
 * edited them), then whatever only the window has (its streaming reply, a message it just sent).
 */
export interface Keyed {
  kind: string
  [k: string]: unknown
}

/** A stable identity for a transcript item, or null when it has none. */
export function itemKey(item: Keyed): string | null {
  const inner = item[item.kind] as { id?: unknown } | undefined
  const id = inner && typeof inner === 'object' && 'id' in inner ? inner.id : item.id
  return typeof id === 'string' && id ? `${item.kind}:${id}` : null
}

export function itemKeys<T extends Keyed>(items: readonly T[]): Set<string> {
  const out = new Set<string>()
  for (const it of items) {
    const k = itemKey(it)
    if (k) out.add(k)
  }
  return out
}

/**
 * `local` is the window's copy (its own edits and deletions are the truth for what it
 * held); `stored` is what the Mac has now; `base` is the keys of what the window last
 * read or saved. What the other writer added is whatever `stored` has that the window
 * neither held nor already has, and it goes on the end. Items the window removed stay
 * removed, and a conversation emptied elsewhere is not brought back.
 */
export function mergeTranscripts<T extends Keyed>(
  stored: readonly T[],
  local: readonly T[],
  base: ReadonlySet<string>
): T[] {
  const mine = itemKeys(local)
  if (stored.length === 0 && base.size > 0) {
    // Cleared by someone else: keep only what the window made since.
    return local.filter((it) => {
      const k = itemKey(it)
      return !k || !base.has(k)
    })
  }
  const added = stored.filter((it) => {
    const k = itemKey(it)
    return !!k && !base.has(k) && !mine.has(k)
  })
  return [...local, ...added]
}
