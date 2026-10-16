import { describe, it, expect } from 'vitest'
import { hidCommand, modifierUsages, normalise } from './sim-hid'

/**
 * What the pane and the agent's tools ask for, as siminput takes it. Getting a
 * coordinate wrong here sends every tap somewhere else; getting a name wrong
 * drops the action through to baguette, which Xcode 27 ignores in silence.
 */
describe('hidCommand', () => {
  it('turns a tap in points into a 0…1 point with a short hold', () => {
    expect(hidCommand({ type: 'tap', x: 201, y: 437, width: 402, height: 874 })).toEqual({
      type: 'tap',
      x: 0.5,
      y: 0.5,
      hold: 0.05
    })
  })

  it('holds a long press for as long as asked', () => {
    expect(
      hidCommand({ type: 'tap', x: 0, y: 0, width: 10, height: 10, duration: 1.2 })
    ).toMatchObject({
      hold: 1.2
    })
  })

  it('keeps a held finger’s phase', () => {
    expect(
      hidCommand({ type: 'touch', phase: 'move', x: 100, y: 200, width: 400, height: 800 })
    ).toEqual({ type: 'touch', phase: 'move', x: 0.25, y: 0.25 })
  })

  it('normalises both ends of a swipe against the same space', () => {
    expect(
      hidCommand({ type: 'swipe', x: 0, y: 800, toX: 400, toY: 0, width: 400, height: 800 })
    ).toEqual({ type: 'swipe', x: 0, y: 1, toX: 1, toY: 0, duration: 0.25 })
  })

  it('works in screenshot pixels too, as the agent’s tools send them', () => {
    expect(normalise(603, 1311, 1206, 2622)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('names keys by HID usage, with modifiers', () => {
    expect(hidCommand({ type: 'key', code: 'Enter' })).toEqual({
      type: 'key',
      usage: 0x28,
      mods: []
    })
    expect(hidCommand({ type: 'key', code: 'ArrowLeft', modifiers: 'shift' })).toEqual({
      type: 'key',
      usage: 0x50,
      mods: [0xe1]
    })
  })

  it('leaves a key it does not know to the old path', () => {
    expect(hidCommand({ type: 'key', code: 'F13' })).toBeNull()
  })

  it('presses the hardware buttons, and Home twice for the app switcher', () => {
    expect(hidCommand({ type: 'press', button: 'home' })).toEqual({
      type: 'button',
      page: 0x0c,
      usage: 0x40
    })
    expect(hidCommand({ type: 'press', button: 'lock' })).toMatchObject({ usage: 0x30 })
    expect(hidCommand({ type: 'press', button: 'app-switcher' })).toMatchObject({
      usage: 0x40,
      count: 2
    })
  })

  it('folds an iPhone Duo by hinge angle, and refuses an angle off the hinge', () => {
    expect(hidCommand({ type: 'hinge', angle: 0 })).toEqual({ type: 'hinge', angle: 0 })
    expect(hidCommand({ type: 'hinge', angle: 180 })).toEqual({ type: 'hinge', angle: 180 })
    expect(hidCommand({ type: 'hinge', angle: 270 })).toBeNull()
    expect(hidCommand({ type: 'hinge' })).toBeNull()
  })

  it('passes text through and leaves orientation to the old path', () => {
    expect(hidCommand({ type: 'text', text: 'Hi!' })).toEqual({ type: 'text', text: 'Hi!' })
    expect(hidCommand({ type: 'orientation', value: 'portrait' })).toBeNull()
  })
})

describe('modifierUsages', () => {
  it('takes a list or a string, any case, and drops what it does not know', () => {
    expect(modifierUsages(['Command', 'shift'])).toEqual([0xe3, 0xe1])
    expect(modifierUsages('cmd+alt')).toEqual([0xe3, 0xe2])
    expect(modifierUsages(['hyper'])).toEqual([])
    expect(modifierUsages(undefined)).toEqual([])
  })
})
