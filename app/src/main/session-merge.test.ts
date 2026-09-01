import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  session: { fromPartition: () => ({}) }
}))
vi.mock('./store', () => ({ kvGet: () => undefined, kvSet: () => undefined }))
vi.mock('./util', () => ({ SHARED_BROWSER_PARTITION: 'persist:browser' }))

const { cookieKey, cookieSetDetails, legacyPartitionDirs } = await import('./session-merge')

/** A cookie carried into the shared jar has to come back the same cookie. */
describe('carrying a cookie between jars', () => {
  const base = {
    name: 'sid',
    value: 'abc',
    path: '/',
    secure: true,
    httpOnly: true,
    session: false
  } as unknown as Electron.Cookie

  /**
   * The one that would be silent: a host-only cookie widened to every
   * subdomain. Chromium marks host-only by the ABSENCE of a leading dot, and
   * set() turns any domain you pass into a domain cookie — so the domain must
   * not be passed back for these.
   */
  it('keeps a host-only cookie host-only', () => {
    const d = cookieSetDetails({ ...base, domain: 'app.example.com' })
    expect(d.domain).toBeUndefined()
    expect(d.url).toBe('https://app.example.com/')
  })

  it('keeps a domain cookie spanning its subdomains', () => {
    const d = cookieSetDetails({ ...base, domain: '.example.com' })
    expect(d.domain).toBe('.example.com')
    // The url still has to name a real host, without the leading dot.
    expect(d.url).toBe('https://example.com/')
  })

  /** Chromium refuses a Secure cookie offered over http, so the scheme tracks it. */
  it('offers an insecure cookie over http', () => {
    const d = cookieSetDetails({ ...base, domain: 'example.com', secure: false })
    expect(d.url).toBe('http://example.com/')
  })

  it('keeps the path in the url', () => {
    const d = cookieSetDetails({ ...base, domain: 'example.com', path: '/app' })
    expect(d.url).toBe('https://example.com/app')
  })
})

describe('deciding what not to overwrite', () => {
  /** Same name on the same site but a different path is a different cookie. */
  it('separates cookies by name, domain and path', () => {
    const a = cookieKey({ name: 'sid', domain: 'example.com', path: '/' })
    const b = cookieKey({ name: 'sid', domain: 'example.com', path: '/admin' })
    const c = cookieKey({ name: 'sid', domain: 'other.com', path: '/' })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('treats the same cookie from two jars as one', () => {
    expect(cookieKey({ name: 'sid', domain: 'example.com', path: '/' })).toBe(
      cookieKey({ name: 'sid', domain: 'example.com', path: '/' })
    )
  })
})

describe('choosing which directories to read', () => {
  it('takes the old per-project jars', () => {
    expect(legacyPartitionDirs(['ws-abc', 'ws-def'])).toEqual(['ws-abc', 'ws-def'])
  })

  /** The shared jar is the destination — reading it as a source would be a loop. */
  it('leaves the shared jar and anything else alone', () => {
    expect(legacyPartitionDirs(['ws-abc', 'browser', 'Default', 'chrome-extension'])).toEqual([
      'ws-abc'
    ])
  })
})
