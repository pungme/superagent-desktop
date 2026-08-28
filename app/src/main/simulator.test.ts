import { describe, it, expect } from 'vitest'
import { baguetteCandidates, navigationReplacesPage } from './simulator'

/**
 * A simulator stream belongs to the page that asked for it. Getting this
 * predicate wrong is expensive in both directions: too eager and a live
 * simulator blanks mid-session, too lax and the helper decodes frames for a
 * pane that no longer exists.
 */
describe('navigationReplacesPage', () => {
  it('is true for a reload or any other main-frame load', () => {
    expect(navigationReplacesPage({ isMainFrame: true, isSameDocument: false })).toBe(true)
  })

  it('is false for same-document navigation — the pane is still there', () => {
    // A hash or history change leaves the renderer, and the pane, untouched.
    expect(navigationReplacesPage({ isMainFrame: true, isSameDocument: true })).toBe(false)
  })

  it('is false for a subframe, which is some other page entirely', () => {
    expect(navigationReplacesPage({ isMainFrame: false, isSameDocument: false })).toBe(false)
    expect(navigationReplacesPage({ isMainFrame: false, isSameDocument: true })).toBe(false)
  })
})

/**
 * Tapping must work out of the box, so the copy the app ships with has to be
 * found before any brew install — and the brew paths must still be there for a
 * build that lacks it.
 */
describe('baguetteCandidates', () => {
  it('tries the bundled copy in Resources first in a packaged app', () => {
    const c = baguetteCandidates(true, '/Applications/SuperAgent.app/Contents/Resources')
    expect(c[0]).toBe('/Applications/SuperAgent.app/Contents/Resources/baguette')
    expect(c.slice(-2)).toEqual(['/opt/homebrew/bin/baguette', '/usr/local/bin/baguette'])
  })

  it('tries native/baguette first in development', () => {
    const c = baguetteCandidates(false, '/unused')
    expect(c[0].endsWith('/native/baguette')).toBe(true)
    expect(c).toContain('/opt/homebrew/bin/baguette')
  })
})
