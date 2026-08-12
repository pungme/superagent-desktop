import { describe, it, expect } from 'vitest'
import { navigationReplacesPage } from './simulator'

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
