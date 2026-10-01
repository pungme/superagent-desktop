import { describe, it, expect } from 'vitest'
import { firefoxUserAgent, firefoxVersion, isSignInHost, isSignInUrl } from './sign-in-identity'

describe("the Firefox identity on Google's sign-in pages", () => {
  it('covers the sign-in hosts and nothing that only looks like one', () => {
    for (const h of [
      'accounts.google.com',
      'accounts.google.de',
      'accounts.google.co.uk',
      'accounts.youtube.com',
      'gds.google.com'
    ])
      expect(isSignInHost(h), h).toBe(true)
    for (const h of [
      'mail.google.com',
      'google.com',
      'accounts.google.com.evil.io',
      'myaccounts.google.com',
      'accounts.googleX.com',
      'accounts.google.evil.example'
    ])
      expect(isSignInHost(h), h).toBe(false)
    expect(isSignInUrl('https://accounts.google.com/v3/signin/identifier')).toBe(true)
    // Not over plain http, and not a look-alike path on another site.
    expect(isSignInUrl('http://accounts.google.com/')).toBe(false)
    expect(isSignInUrl('https://example.com/accounts.google.com')).toBe(false)
    expect(isSignInUrl('not a url')).toBe(false)
  })

  it('names a current Firefox, worked out from the date', () => {
    expect(firefoxVersion(Date.UTC(2025, 8, 16))).toBe(143)
    expect(firefoxVersion(Date.UTC(2025, 9, 14))).toBe(144)
    expect(firefoxVersion(Date.UTC(2020, 0, 1))).toBe(143)
    const v = firefoxVersion(Date.UTC(2026, 9, 1))
    expect(v).toBeGreaterThan(150)
    expect(firefoxUserAgent(Date.UTC(2026, 9, 1))).toBe(
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`
    )
  })
})
