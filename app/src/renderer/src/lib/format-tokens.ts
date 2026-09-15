/** "842" / "12k" / "3.4M" / "1.2B" — compact token counts for badges and stats. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${trimZero((n / 1_000_000_000).toFixed(1))}B`
  if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}
