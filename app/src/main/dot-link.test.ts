import { afterEach, describe, expect, it } from 'vitest'
import { dotOwns, linkDot, switchDotProject } from './dot-link'

describe('the link between the app tools and the dot', () => {
  afterEach(() => linkDot(null))
  it('with no dot, nothing is owned and nothing switches', () => {
    expect(dotOwns('c1')).toBe(false)
    expect(switchDotProject('ws')).toBe(false)
  })
  it('asks the dot once it is there', () => {
    const switched: string[] = []
    linkDot({
      owns: (id) => id === 'c1',
      switchTo: (ws) => {
        switched.push(ws)
        return true
      }
    })
    expect(dotOwns('c1')).toBe(true)
    expect(dotOwns('c2')).toBe(false)
    expect(dotOwns(null)).toBe(false)
    expect(switchDotProject('ws')).toBe(true)
    expect(switched).toEqual(['ws'])
  })
})
