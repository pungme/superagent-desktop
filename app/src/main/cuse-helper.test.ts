import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The native helper, in its dry mode: everything is parsed and nothing is
 * posted, so this never moves the pointer of whoever runs the tests. Skipped
 * where the helper has not been built (it needs a Mac and clang).
 */
const bin = join(__dirname, '..', '..', 'native', 'cuse')
const run = (...args: string[]): Record<string, unknown> => {
  try {
    return JSON.parse(execFileSync(bin, ['--dry', ...args], { encoding: 'utf8' }))
  } catch (e) {
    return JSON.parse(String((e as { stdout?: string }).stdout ?? '{}'))
  }
}

describe.skipIf(!existsSync(bin))('cuse, the hands of computer use', () => {
  it('takes modifiers and one key', () => {
    // 21 is the "4" key; the flags are command and shift.
    expect(run('key', 'cmd+shift+4')).toEqual({ ok: true, key: 21, flags: 0x100000 | 0x20000 })
    expect(run('key', 'return')).toMatchObject({ ok: true, key: 36, flags: 0 })
  })
  it('refuses a key it does not know, two keys, or modifiers alone', () => {
    expect(run('key', 'cmd+nope')).toEqual({ ok: false, error: 'unknown key' })
    expect(run('key', 'a+b')).toMatchObject({ ok: false })
    expect(run('key', 'cmd+shift')).toMatchObject({ ok: false })
  })
  it('accepts each action with its arguments, and says when one is short', () => {
    expect(run('click', '10', '20', 'right', '2')).toEqual({ ok: true })
    expect(run('drag', '1', '2', '3', '4')).toEqual({ ok: true })
    expect(run('scroll', '5', '5', '0', '-3')).toEqual({ ok: true })
    expect(run('move', '5', '5')).toEqual({ ok: true })
    expect(run('click', '10')).toMatchObject({ ok: false })
    expect(run('click', '1', '2', 'left', '9')).toMatchObject({ ok: false })
    expect(run('click', '1', '2', 'sideways')).toMatchObject({ ok: false })
    expect(run('wave')).toEqual({ ok: false, error: 'unknown action' })
  })
  it('has the fast actions remote control uses, and checks their arguments', () => {
    expect(run('jump', '5', '5')).toEqual({ ok: true })
    expect(run('tap', '10', '20')).toEqual({ ok: true })
    expect(run('tap', '10', '20', 'right', '2')).toEqual({ ok: true })
    expect(run('down', '1', '2')).toEqual({ ok: true })
    expect(run('down', '1', '2', 'right')).toEqual({ ok: true })
    expect(run('up', '1', '2')).toEqual({ ok: true })
    expect(run('dragto', '3', '4')).toEqual({ ok: true })
    expect(run('wheel', '5', '5', '0', '-30')).toEqual({ ok: true })
    expect(run('jump', '5')).toMatchObject({ ok: false })
    expect(run('tap', '1', '2', 'left', '9')).toMatchObject({ ok: false })
    expect(run('tap', '1', '2', 'sideways')).toMatchObject({ ok: false })
    expect(run('down', '1', '2', 'sideways')).toMatchObject({ ok: false })
    expect(run('dragto', '1')).toMatchObject({ ok: false })
    expect(run('wheel', '1', '2', '3')).toMatchObject({ ok: false })
  })
  it("reports every window of Superagent's own that a click could land on, except the dot", () => {
    // `at` leaves Superagent's own windows out only when this says so: the dot
    // is a floating panel (layer 3). A native dialog is a modal panel (layer 8)
    // and must read as Superagent's, so a click on its button is never taken for
    // the app beneath it.
    expect(run('ownskip', '3')).toEqual({ skipped: true })
    for (const layer of ['0', '8', '20', '24', '25', '101'])
      expect(run('ownskip', layer), layer).toEqual({ skipped: false })
    expect(run('ownskip')).toMatchObject({ ok: false })
  })
  it('looks at every window layer a click could land on, from the popup-menu level up', () => {
    // `at` used to drop layers above 101 (the screen saver, shielding windows,
    // a prompt drawn over everything); now it reports them.
    for (const layer of [
      '0',
      '3',
      '8',
      '20',
      '24',
      '25',
      '100',
      '101',
      '102',
      '500',
      '1000',
      '2000000'
    ])
      expect(run('layerseen', layer), layer).toEqual({ seen: true })
    for (const layer of ['1', '2', '5', '19', '23', '99'])
      expect(run('layerseen', layer), layer).toEqual({ seen: false })
  })
  it('types text of any script as characters, counted in bytes', () => {
    expect(run('type', 'héllo 👋')).toEqual({ ok: true, chars: 11 })
  })
  it('posts nothing unless Superagent itself ran it', () => {
    // Without --dry, from here: a shell, a script, an agent's own Bash. Refused
    // before any event is made, so this is safe to run at the Mac.
    const real = (...args: string[]): Record<string, unknown> => {
      try {
        return JSON.parse(execFileSync(bin, args, { encoding: 'utf8' }))
      } catch (e) {
        return JSON.parse(String((e as { stdout?: string }).stdout ?? '{}'))
      }
    }
    expect(real('parent')).toEqual({ superagent: false })
    for (const args of [
      ['click', '5', '5'],
      ['move', '5', '5'],
      ['type', 'x'],
      ['key', 'cmd+q'],
      ['drag', '1', '1', '2', '2'],
      ['scroll', '5', '5', '0', '-1']
    ])
      expect(real(...args), args.join(' ')).toEqual({
        ok: false,
        error: 'this helper only acts when Superagent itself runs it'
      })
  })
  it('says which apps have a window on screen, without touching anything', () => {
    const out = JSON.parse(execFileSync(bin, ['windows'], { encoding: 'utf8' })) as {
      apps: { name: string; bundle: string }[]
    }
    expect(Array.isArray(out.apps)).toBe(true)
    for (const a of out.apps) expect(typeof a.name + typeof a.bundle).toBe('stringstring')
  })
})
