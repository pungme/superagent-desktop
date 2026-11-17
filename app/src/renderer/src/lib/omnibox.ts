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

/** A page from history the typed text most likely means: where Enter goes. */
export interface TopHit {
  /** The site's address without scheme or www, as shown in the bar ("appstoreconnect.apple.com"). */
  host: string
  /** Where Enter goes: the site itself, not whichever deep page was visited most. */
  target: string
  title: string
  /**
   * 'inline': the typed text is the start of the address, so the bar completes it
   * ("apps" → "appstoreconnect.apple.com", the rest selected). 'hit': it matches
   * inside the address or starts a word of the title ("conn" → App Store Connect);
   * the bar keeps what was typed and the first suggestion is the site.
   */
  kind: 'inline' | 'hit'
}

const bare = (host: string): string => host.replace(/^www\./i, '').toLowerCase()

/**
 * The top hit for what is typed, from history rows ordered most visited first.
 * Only for a single word: a sentence is a search, and an address typed in full
 * (a scheme, a path) is taken as it is.
 */
export function topHit(typed: string, history: { url: string; title: string }[]): TopHit | null {
  const q = typed.trim().toLowerCase()
  if (q.length < 2 || /\s/.test(q) || SCHEME.test(q) || q.includes('/')) return null
  let hit: TopHit | null = null
  for (const h of history) {
    let u: URL
    try {
      u = new URL(h.url)
    } catch {
      continue
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
    const host = bare(u.hostname) + (u.port ? `:${u.port}` : '')
    const target = `${u.protocol}//${u.host}`
    if (host.startsWith(q)) return { host, target, title: h.title, kind: 'inline' }
    if (hit) continue
    const inTitle = h.title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .some((w) => w.startsWith(q))
    if (host.includes(q) || inTitle) hit = { host, target, title: h.title, kind: 'hit' }
  }
  return hit
}
