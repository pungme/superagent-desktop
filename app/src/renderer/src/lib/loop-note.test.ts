import { describe, it, expect } from 'vitest'
import { splitLoopNote } from './loop-note'

describe('splitLoopNote', () => {
  it('splits the self-paced reminder off a loop round', () => {
    const text =
      'do 10 of them\n\n' +
      '(/loop, self-paced: you decide when the next round should run. If it should not ' +
      'start immediately, run `sleep <seconds>` in the shell as your last action before ' +
      'ending the turn — the next round begins when your turn ends. Keep rounds brief; ' +
      'the loop runs until stopped.)'
    const { main, note } = splitLoopNote(text)
    expect(main).toBe('do 10 of them')
    expect(note).toMatch(/^\(\/loop, self-paced:/)
  })

  it('splits an interval-based reminder too', () => {
    const { main, note } = splitLoopNote(
      'check status\n\n(/loop 5m: fires automatically. Stop anytime.)'
    )
    expect(main).toBe('check status')
    expect(note).toBe('(/loop 5m: fires automatically. Stop anytime.)')
  })

  it('leaves an ordinary message untouched', () => {
    const { main, note } = splitLoopNote('just a normal message')
    expect(main).toBe('just a normal message')
    expect(note).toBeNull()
  })

  it('does not match a parenthetical that merely mentions /loop mid-sentence', () => {
    const { main, note } = splitLoopNote('can you explain what /loop does?')
    expect(main).toBe('can you explain what /loop does?')
    expect(note).toBeNull()
  })
})
