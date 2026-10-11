import { describe, expect, it } from 'vitest'
import { frameWanted, mirrorShotWidth, unseenPaneSize } from './mirror-shot'

describe("how wide the phone's picture of a page is", () => {
  it('is 700 unless more is asked for, and never past 1400', () => {
    expect(mirrorShotWidth(undefined)).toBe(700)
    expect(mirrorShotWidth(700)).toBe(700)
    expect(mirrorShotWidth(1400)).toBe(1400)
    expect(mirrorShotWidth(1600)).toBe(1400)
    expect(mirrorShotWidth(50)).toBe(200)
    expect(mirrorShotWidth(NaN)).toBe(700)
  })
})

describe('the size an unseen page is laid out at for the phone', () => {
  const win = { width: 1280, height: 800 }
  it("is the pane's own size the last time it was on screen", () => {
    expect(unseenPaneSize({ width: 640, height: 720 }, win)).toEqual({ width: 640, height: 720 })
  })
  it('is held within the window as it is now', () => {
    expect(unseenPaneSize({ width: 900, height: 1000 }, { width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600
    })
  })
  it('is a column half the window wide and its full height for a page never shown', () => {
    expect(unseenPaneSize(null, win)).toEqual({ width: 640, height: 800 })
    expect(unseenPaneSize({ width: 0, height: 0 }, win)).toEqual({ width: 640, height: 800 })
  })
  it('never collapses to a strip', () => {
    expect(unseenPaneSize({ width: 10, height: 10 }, win)).toEqual({ width: 320, height: 240 })
    expect(unseenPaneSize(null, { width: 100, height: 100 })).toEqual({ width: 320, height: 240 })
  })
})

describe('whether a frame has to go to the phone', () => {
  it('goes unless it is the one the phone says it holds', () => {
    expect(frameWanted('a', 'a', 'a')).toBe(false)
    expect(frameWanted('b', 'a', 'b')).toBe(true)
  })
  it('a phone that says nothing gets the old rule: the last frame sent to anyone', () => {
    expect(frameWanted('a', undefined, 'a')).toBe(false)
    expect(frameWanted('a', '', 'a')).toBe(false)
    expect(frameWanted('a', undefined, undefined)).toBe(true)
    expect(frameWanted('a', undefined, 'b')).toBe(true)
  })
})
