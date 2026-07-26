import { describe, it, expect } from 'vitest'
import { interpretOmnibox } from './omnibox'

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
