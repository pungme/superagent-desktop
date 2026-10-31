/** When a usage window starts over: "6 PM" today, else "Mon 10 PM". */
export function resetLabel(at: number, now: number): string {
  // To the nearest minute: a window reported as ending at 15:59:59.9 ends at 4.
  const d = new Date(Math.round(at / 60_000) * 60_000)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return at - now < 20 * 3_600_000
    ? time
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** The same moment, as short as it reads: "40m" or "5h" while it is close, else the day ("Wed"). */
export function resetShort(at: number, now: number): string {
  const left = at - now
  if (left < 3_600_000) return `${Math.max(1, Math.round(left / 60_000))}m`
  if (left < 24 * 3_600_000) return `${Math.round(left / 3_600_000)}h`
  return new Date(at).toLocaleDateString([], { weekday: 'short' })
}
