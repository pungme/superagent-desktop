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

export function mergeTranscripts<T extends Keyed>(stored: T[], local: T[]): T[] {
  const mine = new Map<string, T>()
  for (const it of local) {
    const k = itemKey(it)
    if (k) mine.set(k, it)
  }
  const seen = new Set<string>()
  const out: T[] = []
  for (const it of stored) {
    const k = itemKey(it)
    if (k) seen.add(k)
    out.push((k && mine.get(k)) || it)
  }
  for (const it of local) {
    const k = itemKey(it)
    // An item with no identity cannot be matched: keep it only if the stored copy lacks it entirely.
    if (k ? !seen.has(k) : !stored.some((s) => JSON.stringify(s) === JSON.stringify(it)))
      out.push(it)
  }
  return out
}
