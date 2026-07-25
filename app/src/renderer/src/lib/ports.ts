// Extract dev-server ports from terminal output.
// Matches Vite/Next/CRA style "Local: http://localhost:3000" lines.
const PORT_RE = /(?:localhost|127\.0\.0\.1):(\d{2,5})\b/g

export function extractPorts(chunk: string): number[] {
  const found: number[] = []
  for (const m of chunk.matchAll(PORT_RE)) {
    const port = Number(m[1])
    if (port >= 1024 && port <= 65535 && !found.includes(port)) found.push(port)
  }
  return found
}
