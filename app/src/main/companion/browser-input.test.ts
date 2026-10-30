import { describe, it, expect, beforeEach } from 'vitest'
import {
  browserInputParams,
  toPanePoint,
  toPaneSteps,
  deliverBrowserInput,
  _resetHeldButtons,
  type PaneEvent
} from './browser-input'

const pane = { width: 800, height: 600 }

describe('toPanePoint', () => {
  it('scales a point on the picture onto the pane', () => {
    expect(toPanePoint(0, 0, pane)).toEqual({ x: 0, y: 0 })
    expect(toPanePoint(0.5, 0.5, pane)).toEqual({ x: 400, y: 300 })
    expect(toPanePoint(0.25, 0.1, pane)).toEqual({ x: 200, y: 60 })
  })

  it('keeps the far edge inside the view', () => {
    expect(toPanePoint(1, 1, pane)).toEqual({ x: 799, y: 599 })
  })

  it('does not care how big the picture was: only the fraction counts', () => {
    // A 700-wide picture of a 1400-point pane: picture pixel 350 is the middle.
    expect(toPanePoint(350 / 700, 0, { width: 1400, height: 900 }).x).toBe(700)
  })
})

describe('browserInputParams', () => {
  const ok = (action: unknown): boolean =>
    browserInputParams.safeParse({ chatId: 'c1', action }).success

  it('takes every action the phone sends', () => {
    expect(ok({ type: 'move', x: 0.1, y: 0.2 })).toBe(true)
    expect(ok({ type: 'click', x: 0.1, y: 0.2 })).toBe(true)
    expect(ok({ type: 'click', x: 0.1, y: 0.2, button: 'right', count: 2 })).toBe(true)
    expect(ok({ type: 'down', x: 0, y: 1 })).toBe(true)
    expect(ok({ type: 'up', x: 1, y: 0, button: 'left' })).toBe(true)
    expect(ok({ type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.3 })).toBe(true)
    expect(ok({ type: 'text', text: 'hello ✓' })).toBe(true)
    expect(ok({ type: 'key', key: 'Enter' })).toBe(true)
    expect(ok({ type: 'key', key: 'Tab', shift: true })).toBe(true)
  })

  it('refuses points off the picture, odd buttons and keys, and runaway input', () => {
    expect(ok({ type: 'click', x: 1.2, y: 0.2 })).toBe(false)
    expect(ok({ type: 'click', x: -0.01, y: 0.2 })).toBe(false)
    expect(ok({ type: 'click', x: Number.NaN, y: 0.2 })).toBe(false)
    expect(ok({ type: 'click', x: 0.5, y: 0.5, button: 'middle' })).toBe(false)
    expect(ok({ type: 'click', x: 0.5, y: 0.5, count: 9 })).toBe(false)
    expect(ok({ type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 500 })).toBe(false)
    expect(ok({ type: 'text', text: '' })).toBe(false)
    expect(ok({ type: 'text', text: 'x'.repeat(2001) })).toBe(false)
    // No modifier keys beyond shift: ⌘W or ⌘Q must not be pressable from here.
    expect(ok({ type: 'key', key: 'w', meta: true })).toBe(false)
    expect(ok({ type: 'key', key: 'F5' })).toBe(false)
    expect(ok({ type: 'keyDown', keyCode: 'a' })).toBe(false)
    expect(browserInputParams.safeParse({ action: { type: 'move', x: 0, y: 0 } }).success).toBe(
      false
    )
  })
})

describe('toPaneSteps', () => {
  const events = (steps: ReturnType<typeof toPaneSteps>): PaneEvent[] =>
    steps.flatMap((s) => ('event' in s ? [s.event] : []))

  it('a tap is a move onto the point, then a press and release there', () => {
    const ev = events(toPaneSteps({ type: 'click', x: 0.5, y: 0.25 }, pane))
    expect(ev).toEqual([
      { type: 'mouseMove', x: 400, y: 150 },
      { type: 'mouseDown', x: 400, y: 150, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 400, y: 150, button: 'left', clickCount: 1 }
    ])
  })

  it('the second press of a double-click says 2; a right-click uses the right button', () => {
    const second = events(toPaneSteps({ type: 'click', x: 0, y: 0, count: 2 }, pane))
    expect(second.map((e) => [e.type, (e as { clickCount?: number }).clickCount])).toEqual([
      ['mouseMove', undefined],
      ['mouseDown', 2],
      ['mouseUp', 2]
    ])
    const right = events(toPaneSteps({ type: 'click', x: 0, y: 0, button: 'right' }, pane))
    expect(right[1]).toMatchObject({ type: 'mouseDown', button: 'right' })
  })

  it('a move with a button held says so (a drag), and without one is a hover', () => {
    expect(events(toPaneSteps({ type: 'move', x: 0.5, y: 0.5 }, pane))[0]).toEqual({
      type: 'mouseMove',
      x: 400,
      y: 300
    })
    const drag = events(toPaneSteps({ type: 'move', x: 0.5, y: 0.5 }, pane, new Set(['left'])))
    expect(drag[0]).toMatchObject({ modifiers: ['leftbuttondown'] })
  })

  it('a scroll moves the page with the finger, in the pane’s points', () => {
    const [wheel] = events(toPaneSteps({ type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.5 }, pane))
    expect(wheel).toMatchObject({ type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: -300 })
    expect(toPaneSteps({ type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.0001 }, pane)).toEqual([])
  })

  it('text is inserted as it is; Return also types its character', () => {
    expect(toPaneSteps({ type: 'text', text: 'héllo 👋' }, pane)).toEqual([{ text: 'héllo 👋' }])
    expect(events(toPaneSteps({ type: 'key', key: 'Enter' }, pane))).toEqual([
      { type: 'keyDown', keyCode: 'Return', modifiers: [] },
      { type: 'char', keyCode: '\r', modifiers: [] },
      { type: 'keyUp', keyCode: 'Return', modifiers: [] }
    ])
    expect(events(toPaneSteps({ type: 'key', key: 'Tab', shift: true }, pane))).toEqual([
      { type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] },
      { type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] }
    ])
    expect(events(toPaneSteps({ type: 'key', key: 'ArrowLeft' }, pane))[0]).toMatchObject({
      keyCode: 'Left'
    })
  })
})

describe('deliverBrowserInput', () => {
  beforeEach(() => _resetHeldButtons())

  const target = (): {
    sent: PaneEvent[]
    typed: string[]
    dead: boolean
    isDestroyed: () => boolean
    sendInputEvent: (e: PaneEvent) => void
    insertText: (t: string) => Promise<void>
  } => {
    const t = {
      sent: [] as PaneEvent[],
      typed: [] as string[],
      dead: false,
      isDestroyed: () => t.dead,
      sendInputEvent: (e: PaneEvent) => void t.sent.push(e),
      insertText: async (s: string) => void t.typed.push(s)
    }
    return t
  }

  it('remembers a held button between down and up, per pane', async () => {
    const a = target()
    await deliverBrowserInput('p1', a, pane, { type: 'down', x: 0.1, y: 0.1 })
    await deliverBrowserInput('p1', a, pane, { type: 'move', x: 0.2, y: 0.1 })
    await deliverBrowserInput('p2', a, pane, { type: 'move', x: 0.2, y: 0.1 })
    await deliverBrowserInput('p1', a, pane, { type: 'up', x: 0.2, y: 0.1 })
    await deliverBrowserInput('p1', a, pane, { type: 'move', x: 0.3, y: 0.1 })
    const moves = a.sent.filter((e) => e.type === 'mouseMove')
    expect(moves.map((m) => (m as { modifiers?: string[] }).modifiers)).toEqual([
      undefined, // onto the point before the press
      ['leftbuttondown'],
      undefined, // another pane holds nothing
      undefined
    ])
  })

  it('types text and sends nothing to a pane that is gone', async () => {
    const a = target()
    await deliverBrowserInput('p1', a, pane, { type: 'text', text: 'hi' })
    expect(a.typed).toEqual(['hi'])
    a.dead = true
    await deliverBrowserInput('p1', a, pane, { type: 'click', x: 0.5, y: 0.5 })
    expect(a.sent).toEqual([])
  })

  it('a key sent straight after text waits for the text to land', async () => {
    const order: string[] = []
    let land: () => void = () => {}
    const a = {
      isDestroyed: () => false,
      sendInputEvent: (e: PaneEvent) => void order.push(e.type),
      insertText: (t: string) =>
        new Promise<void>((r) => {
          land = () => {
            order.push(`text:${t}`)
            r()
          }
        })
    }
    // Not awaited: the phone's frames arrive back to back.
    const typed = deliverBrowserInput('p1', a, pane, { type: 'text', text: 'abc!' })
    const key = deliverBrowserInput('p1', a, pane, { type: 'key', key: 'Backspace' })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([])
    land()
    await Promise.all([typed, key])
    expect(order).toEqual(['text:abc!', 'keyDown', 'keyUp'])
  })
})
