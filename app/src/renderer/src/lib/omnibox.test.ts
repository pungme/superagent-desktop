import { describe, it, expect } from 'vitest'
import { interpretOmnibox, topHit } from './omnibox'

describe('interpretOmnibox', () => {
  it('navigates explicit URLs as-is', () => {
    expect(interpretOmnibox('https://example.com')).toEqual({
      kind: 'url',
      target: 'https://example.com'
    })
  })
  it('adds https to bare domains', () => {
    expect(interpretOmnibox('producthunt.com')).toEqual({
      kind: 'url',
      target: 'https://producthunt.com'
    })
    expect(interpretOmnibox('google.com/search?q=x')?.kind).toBe('url')
  })
  it('uses http for localhost with a port', () => {
    expect(interpretOmnibox('localhost:3000')).toEqual({
      kind: 'url',
      target: 'http://localhost:3000'
    })
  })
  it('searches free text', () => {
    const r = interpretOmnibox('pung worathiti')
    expect(r?.kind).toBe('search')
    expect(r?.target).toContain('google.com/search?q=pung%20worathiti')
  })
  it('searches a single word with no dot', () => {
    expect(interpretOmnibox('hello')?.kind).toBe('search')
  })
  it('returns null for empty input', () => {
    expect(interpretOmnibox('   ')).toBeNull()
  })
})

describe('topHit', () => {
  const history = [
    { url: 'https://appstoreconnect.apple.com/apps/123/distribution', title: 'App Store Connect' },
    { url: 'https://www.github.com/pungme/superagent-desktop', title: 'pungme/superagent-desktop' },
    { url: 'http://localhost:5173/', title: 'Vite app' }
  ]
  it('completes the address when what is typed starts it', () => {
    expect(topHit('apps', history)).toEqual({
      host: 'appstoreconnect.apple.com',
      target: 'https://appstoreconnect.apple.com',
      title: 'App Store Connect',
      kind: 'inline'
    })
    // www is not typed, and not shown; the site keeps its own address.
    expect(topHit('git', history)).toMatchObject({
      host: 'github.com',
      target: 'https://www.github.com',
      kind: 'inline'
    })
    expect(topHit('local', history)).toMatchObject({
      host: 'localhost:5173',
      target: 'http://localhost:5173'
    })
  })
  it('offers the site when the text is inside the address or starts a word of the title', () => {
    expect(topHit('conn', history)).toMatchObject({
      host: 'appstoreconnect.apple.com',
      kind: 'hit'
    })
    expect(topHit('store', history)).toMatchObject({
      host: 'appstoreconnect.apple.com',
      kind: 'hit'
    })
  })
  it('prefers a start-of-address match over an earlier inside match', () => {
    expect(topHit('pung', [...history, { url: 'https://pung.dev/', title: 'pung' }])).toMatchObject(
      {
        host: 'pung.dev',
        kind: 'inline'
      }
    )
  })
  it('leaves sentences, full addresses, one letter and no match alone', () => {
    expect(topHit('app store', history)).toBeNull()
    expect(topHit('https://app', history)).toBeNull()
    expect(topHit('github.com/pungme', history)).toBeNull()
    expect(topHit('a', history)).toBeNull()
    expect(topHit('zzz', history)).toBeNull()
  })
})
