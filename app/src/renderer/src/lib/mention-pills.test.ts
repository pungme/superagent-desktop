import { describe, it, expect } from 'vitest'
import {
  compactMentions,
  expandMentions,
  pillBefore,
  pillSegments,
  registerMention,
  tokenFor,
  type MentionMap
} from './mention-pills'

const P = '/Users/me/HOBBY/wepush/wepush-creator-manager/'

describe('mention pills', () => {
  it('names a path by its last segment, a project file as itself', () => {
    const map: MentionMap = new Map()
    expect(tokenFor(P, map)).toBe('wepush-creator-manager')
    expect(tokenFor('src/app.ts', map)).toBe('src/app.ts')
  })

  it('tells two paths with the same name apart', () => {
    const map: MentionMap = new Map()
    registerMention('/a/one/README.md', map)
    expect(registerMention('/a/two/README.md', map)).toBe('two/README.md')
    // The same path again keeps its name rather than growing a new one.
    expect(registerMention('/a/one/README.md', map)).toBe('README.md')
  })

  it('compacts a finished mention and keeps the caret with its text', () => {
    const map: MentionMap = new Map()
    const text = `this project is concerning @${P} and more`
    const caret = text.length
    const out = compactMentions(text, caret, map)
    expect(out.text).toBe('this project is concerning @wepush-creator-manager and more')
    expect(out.caret).toBe(out.text.length)
  })

  it('leaves the mention still being typed alone', () => {
    const map: MentionMap = new Map()
    const text = `see @${P}`
    expect(compactMentions(text, text.length, map).text).toBe(text)
  })

  it('round-trips: what is sent is what was picked', () => {
    const map: MentionMap = new Map()
    const typed = `this project is concerning @${P} please.`
    const shown = compactMentions(typed, typed.length, map).text
    expect(expandMentions(shown, map)).toBe(typed)
    // Punctuation after a pill doesn't hide it.
    expect(expandMentions('look at @wepush-creator-manager, now', map)).toBe(
      `look at @${P}, now`
    )
  })

  it('cuts the text into the same characters, pills marked', () => {
    const map: MentionMap = new Map([['app.ts', 'src/app.ts']])
    const segs = pillSegments('fix @app.ts and @unknown now', map)
    expect(segs.map((s) => s.text).join('')).toBe('fix @app.ts and @unknown now')
    expect(segs.filter((s) => s.pill).map((s) => s.text)).toEqual(['@app.ts'])
  })

  it('finds the whole pill before the caret for one-stroke delete', () => {
    const map: MentionMap = new Map([['app.ts', 'src/app.ts']])
    expect(pillBefore('fix @app.ts', 11, map)).toBe(4)
    expect(pillBefore('fix @nope', 9, map)).toBeNull()
    expect(pillBefore('fix @app.ts ', 12, map)).toBeNull()
  })
})
