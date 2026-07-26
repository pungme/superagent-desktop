/** How the omnibar interprets a typed string: navigate to a URL, or web-search it. */
export interface Omnibox {
  kind: 'url' | 'search'
  /** The full URL to load (a real page, or a Google search results URL). */
  target: string
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i
// A bare domain: no spaces, at least one dot, a 2+ char TLD (optionally a path/port).
const DOMAIN = /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i

export function interpretOmnibox(raw: string): Omnibox | null {
  const s = raw.trim()
  if (!s) return null
  if (SCHEME.test(s)) return { kind: 'url', target: s }
  if (LOCAL.test(s)) return { kind: 'url', target: `http://${s}` }
  if (DOMAIN.test(s)) return { kind: 'url', target: `https://${s}` }
  return { kind: 'search', target: `https://www.google.com/search?q=${encodeURIComponent(s)}` }
}
