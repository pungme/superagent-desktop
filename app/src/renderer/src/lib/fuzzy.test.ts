import { describe, it, expect } from 'vitest'
import { fuzzyScore, fuzzyFilter } from './fuzzy'

describe('fuzzyScore', () => {
  it('matches a prefix', () => {
    expect(fuzzyScore('shot', 'Shotcaller')).not.toBeNull()
  })

  it('matches scattered characters in order', () => {
    expect(fuzzyScore('shot', 'the shot caller')).not.toBeNull()
  })

  it('rejects a query whose characters are out of order', () => {
    expect(fuzzyScore('tohs', 'Shotcaller')).toBeNull()
  })

  it('rejects a character missing from the target entirely', () => {
    expect(fuzzyScore('shotz', 'Shotcaller')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('SHOT', 'shotcaller')).not.toBeNull()
  })

  it('ranks a contiguous prefix match above a scattered one', () => {
    const prefix = fuzzyScore('shot', 'Shotcaller')!
    const scattered = fuzzyScore('shot', 'the show of tricks')!
    expect(prefix).toBeGreaterThan(scattered)
  })

  it('treats an empty query as a match for everything, with score 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })
})

describe('fuzzyFilter', () => {
  it('returns everything, unranked, for an empty query', () => {
    expect(fuzzyFilter(['b', 'a', 'c'], '', (s) => s)).toEqual(['b', 'a', 'c'])
  })

  it('drops non-matches and ranks the rest best-first', () => {
    const items = ['Shotcaller', 'Superagent iOS', 'the shot caller']
    const out = fuzzyFilter(items, 'shot', (s) => s)
    expect(out).toEqual(['Shotcaller', 'the shot caller'])
  })
})
