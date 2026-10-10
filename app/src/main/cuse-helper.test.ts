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
