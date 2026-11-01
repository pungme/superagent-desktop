import { describe, expect, it } from 'vitest'
import { remoteInputParams, remoteCodeParams, remoteViewParams, toStep } from './input'

const parse = (actions: unknown[]): ReturnType<typeof remoteInputParams.safeParse> =>
  remoteInputParams.safeParse({ actions })

describe('what the phone may send', () => {
  it('takes each kind of action', () => {
    expect(
      parse([
        { type: 'move', x: 0.1, y: 0.2 },
        { type: 'click', x: 0.5, y: 0.5, button: 'right', count: 2 },
        { type: 'down', x: 0, y: 1 },
        { type: 'up', x: 0, y: 1, button: 'left' },
        { type: 'drag', x: 0, y: 0, toX: 1, toY: 1 },
        { type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.3 },
        { type: 'text', text: 'hello 👋' },
        { type: 'key', key: 'space', mods: ['cmd'] }
      ]).success
    ).toBe(true)
  })

  it('refuses points outside the picture, and numbers that are not numbers', () => {
    expect(parse([{ type: 'move', x: 1.01, y: 0 }]).success).toBe(false)
    expect(parse([{ type: 'move', x: -0.01, y: 0 }]).success).toBe(false)
    expect(parse([{ type: 'move', x: NaN, y: 0 }]).success).toBe(false)
    expect(parse([{ type: 'move', x: '0.5', y: 0 }]).success).toBe(false)
    expect(parse([{ type: 'scroll', x: 0, y: 0, dx: 0, dy: 2 }]).success).toBe(false)
  })

  it('refuses a button, count, key or modifier it does not know', () => {
    expect(parse([{ type: 'click', x: 0, y: 0, button: 'middle' }]).success).toBe(false)
    expect(parse([{ type: 'click', x: 0, y: 0, count: 4 }]).success).toBe(false)
    expect(parse([{ type: 'click', x: 0, y: 0, count: 0 }]).success).toBe(false)
    expect(parse([{ type: 'key', key: 'power' }]).success).toBe(false)
    expect(parse([{ type: 'key', key: 'a', mods: ['super'] }]).success).toBe(false)
  })

  it('refuses unknown fields and unknown actions, so nothing rides along', () => {
    expect(parse([{ type: 'move', x: 0, y: 0, shell: 'rm -rf' }]).success).toBe(false)
    expect(parse([{ type: 'run', cmd: 'ls' }]).success).toBe(false)
    expect(remoteInputParams.safeParse({ actions: [], extra: 1 }).success).toBe(false)
  })

  it('refuses text with control characters, and an empty or oversized batch', () => {
    expect(parse([{ type: 'text', text: 'a\nb' }]).success).toBe(false)
    expect(parse([{ type: 'text', text: '' }]).success).toBe(false)
    expect(parse([]).success).toBe(false)
    expect(parse(Array(33).fill({ type: 'move', x: 0, y: 0 })).success).toBe(false)
    expect(parse(Array(32).fill({ type: 'move', x: 0, y: 0 })).success).toBe(true)
  })

  it('takes a code of six digits and nothing else', () => {
    expect(remoteCodeParams.safeParse({ code: '012345' }).success).toBe(true)
    for (const bad of ['12345', '1234567', 'abcdef', '12 345', ''])
      expect(remoteCodeParams.safeParse({ code: bad }).success).toBe(false)
  })

  it('takes a view update with sane limits', () => {
    expect(remoteViewParams.safeParse({ visible: false, maxWidth: 1200, key: true }).success).toBe(
      true
    )
    expect(remoteViewParams.safeParse({ maxWidth: 10 }).success).toBe(false)
    expect(remoteViewParams.safeParse({ maxWidth: 99999 }).success).toBe(false)
  })
})

describe('what each action is, for the helper', () => {
  const main = { x: 0, y: 0, width: 1440, height: 900 }
  // A display to the right of the main one, bigger, and above it.
  const second = { x: 1440, y: -300, width: 2560, height: 1440 }

  it('maps points onto the shared display, in system coordinates', () => {
    expect(toStep({ type: 'click', x: 0.5, y: 0.5 }, main, null).args).toEqual([
      'tap',
      '720',
      '450',
      'left',
      '1'
    ])
    expect(
      toStep({ type: 'click', x: 0, y: 0, button: 'right', count: 2 }, second, null).args
    ).toEqual(['tap', '1440', '-300', 'right', '2'])
    const corner = toStep({ type: 'click', x: 1, y: 1 }, second, null)
    expect(corner.points).toEqual([{ x: 1440 + 2559, y: -300 + 1439 }])
  })

  it('a move is a drag while the left button is held, and only a move otherwise', () => {
    expect(toStep({ type: 'move', x: 0.1, y: 0.1 }, main, null).args[0]).toBe('jump')
    expect(
      toStep({ type: 'move', x: 0.1, y: 0.1 }, main, { button: 'left', at: { x: 5, y: 5 } }).args[0]
    ).toBe('dragto')
    expect(
      toStep({ type: 'move', x: 0.1, y: 0.1 }, main, { button: 'right', at: { x: 5, y: 5 } })
        .args[0]
    ).toBe('jump')
  })

  it('a drag names both of its ends for the guard', () => {
    const s = toStep({ type: 'drag', x: 0, y: 0, toX: 1, toY: 1 }, main, null)
    expect(s.args).toEqual(['drag', '0', '0', '1439', '899'])
    expect(s.points).toHaveLength(2)
  })

  it('scrolls in pixels and types text as one argument, never a shell string', () => {
    expect(toStep({ type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 }, main, null).args).toEqual([
      'wheel',
      '720',
      '450',
      '0',
      '90'
    ])
    const t = toStep({ type: 'text', text: '$(rm -rf ~); `x` "q"' }, main, null)
    expect(t.args).toEqual(['type', '$(rm -rf ~); `x` "q"'])
    expect(t.kind).toBe('keys')
  })
})
