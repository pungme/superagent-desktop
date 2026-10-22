/**
 * Settings main owns in the kv table. The window mirrors its localStorage into
 * the same table (renderer/main.tsx), and once copied one of these into
 * localStorage: from then on every new window wrote the stale copy back over
 * what main had saved. That is how a dot turned off in Settings came back on
 * every update (2026-10-21, caught writing `dot.enabled=1` 25 s after a
 * restart), and the same path could have switched computer use or Mail back
 * on. Main is the only writer of these; the mirror never reads or writes them.
 */
const OWNED = [
  'dot.enabled',
  'dot.hotkey',
  'dot.talkHotkey',
  'app.hotkey',
  'computer.',
  'companion.',
  'connections.',
  'power.',
  'migrated.',
  'sim.',
  'cove.betaUpdates',
  'cove.partitions-merged'
]

export function isMainOwnedKey(key: string): boolean {
  return OWNED.some((k) => (k.endsWith('.') ? key.startsWith(k) : key === k))
}
