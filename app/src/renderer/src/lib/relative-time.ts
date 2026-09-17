/** "now" / "25m" / "17h" / "yesterday" / "3d" — the sidebar's own shorthand,
 *  compact enough to sit beside a title without crowding it. */
export function when(at?: number): string {
  if (!at) return ''
  const secs = Math.max(0, (Date.now() - at) / 1000)
  if (secs < 60) return 'now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`
  if (secs < 172_800) return 'yesterday'
  return `${Math.floor(secs / 86_400)}d`
}
