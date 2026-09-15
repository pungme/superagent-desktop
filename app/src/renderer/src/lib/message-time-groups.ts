/** iMessage-style time clustering: a message shows its timestamp only when
 *  the next one is a real pause away (or there is no next one) — sending a
 *  follow-up right after retires the previous message's timestamp instead of
 *  stamping every single message in a burst. */
export const TIME_GROUP_GAP_MS = 5 * 60 * 1000

/** Ids of the messages (in `msgs` order) that should show their timestamp. */
export function visibleTimeIds<T extends { id: string }>(
  msgs: T[],
  at: (m: T) => number | null,
  gapMs = TIME_GROUP_GAP_MS
): Set<string> {
  const ids = new Set<string>()
  for (let i = 0; i < msgs.length; i++) {
    const cur = at(msgs[i])
    if (cur === null) continue
    const next = msgs[i + 1]
    const nextAt = next ? at(next) : null
    if (nextAt === null || nextAt - cur > gapMs) ids.add(msgs[i].id)
  }
  return ids
}
