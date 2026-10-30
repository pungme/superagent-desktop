import { z } from 'zod'
import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent } from 'electron'
import {
  BROWSER_INPUT_KEYS,
  type BrowserInputAction,
  type BrowserInputButton,
  type BrowserInputKey
} from '../../shared/companion-protocol'

/**
 * The phone using the page it mirrors (`browser.input`): taps, the trackpad's
 * pointer, the wheel, typing. Delivered to that one conversation's pane with
 * Electron's `webContents.sendInputEvent`, the way the page would get a click
 * or a key from the Mac's own trackpad and keyboard while it has focus. Never
 * OS-level events, and nothing here goes near computer use or `cuse`: the
 * events cannot reach anything but this page.
 *
 * It is the user's input, not the agent's: it goes in without the debugger
 * (which is the agent's way in, and what a site sees as a bot), it does not
 * announce "the agent is browsing", and it is allowed while the agent's hands
 * are off the page for a sign-in — that is exactly when the user is the one
 * who has to type.
 */

/** A point on the picture, 0..1 across and down. */
const frac = z.number().finite().min(0).max(1)
const button = z.enum(['left', 'right']).optional()

export const browserInputParams = z.object({
  chatId: z.string().min(1),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('move'), x: frac, y: frac }),
    z.object({
      type: z.literal('click'),
      x: frac,
      y: frac,
      button,
      count: z.number().int().min(1).max(3).optional()
    }),
    z.object({ type: z.literal('down'), x: frac, y: frac, button }),
    z.object({ type: z.literal('up'), x: frac, y: frac, button }),
    z.object({
      type: z.literal('scroll'),
      x: frac,
      y: frac,
      // A flick is a few screens at most; anything past that is not a finger.
      dx: z.number().finite().min(-10).max(10),
      dy: z.number().finite().min(-10).max(10)
    }),
    z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }),
    z.object({
      type: z.literal('key'),
      key: z.enum(BROWSER_INPUT_KEYS),
      shift: z.boolean().optional()
    })
  ])
})

export interface Size {
  width: number
  height: number
}

/**
 * A point on the phone's picture, in the pane's own points: where
 * `sendInputEvent` takes it. The picture is the whole view (the capture is the
 * view at the screen's scale, then shrunk), so it is a straight scale, whatever
 * the page's zoom, the screen's scale or the size the picture was shrunk to;
 * Chromium takes the zoom back out on its side. Held inside the view.
 */
export function toPanePoint(x: number, y: number, size: Size): { x: number; y: number } {
  const w = Math.max(1, Math.round(size.width))
  const h = Math.max(1, Math.round(size.height))
  return {
    x: Math.min(w - 1, Math.max(0, Math.floor(x * w))),
    y: Math.min(h - 1, Math.max(0, Math.floor(y * h)))
  }
}

/** Electron's names for the keys the phone has. */
const KEY_CODES: Record<BrowserInputKey, string> = {
  Enter: 'Return',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

export type PaneEvent = MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent

/** What one action becomes: events for `sendInputEvent`, or text to insert. */
export type PaneStep = { event: PaneEvent } | { text: string }

const heldFlag = (b: BrowserInputButton): 'leftbuttondown' | 'rightbuttondown' =>
  b === 'right' ? 'rightbuttondown' : 'leftbuttondown'

/**
 * The events one action is. `held` is the buttons already down on this page
 * (from a `down` with no `up` yet): a move with one held is a drag, and says
 * so, or a page's drag handler sees a hover.
 */
export function toPaneSteps(
  action: BrowserInputAction,
  size: Size,
  held: ReadonlySet<BrowserInputButton> = new Set()
): PaneStep[] {
  const mouse = (
    type: 'mouseMove' | 'mouseDown' | 'mouseUp',
    at: { x: number; y: number },
    extra: Partial<MouseInputEvent> = {}
  ): PaneStep => {
    const modifiers = [...held].map(heldFlag)
    const event: MouseInputEvent = { type, x: at.x, y: at.y, ...extra }
    if (modifiers.length && type === 'mouseMove') event.modifiers = modifiers
    return { event }
  }
  switch (action.type) {
    case 'move':
      return [mouse('mouseMove', toPanePoint(action.x, action.y, size))]
    case 'click': {
      const at = toPanePoint(action.x, action.y, size)
      const b = action.button ?? 'left'
      // As a mouse reports it: the second press of a double-click says 2. The
      // phone sends the first tap as 1 and the quick second as 2.
      const clickCount = action.count ?? 1
      // Onto it first: a page's hover state and pointerenter come before the
      // press, as they do under a real pointer.
      const steps: PaneStep[] = [
        mouse('mouseMove', at),
        mouse('mouseDown', at, { button: b, clickCount }),
        mouse('mouseUp', at, { button: b, clickCount })
      ]
      return steps
    }
    case 'down': {
      const at = toPanePoint(action.x, action.y, size)
      const b = action.button ?? 'left'
      return [mouse('mouseMove', at), mouse('mouseDown', at, { button: b, clickCount: 1 })]
    }
    case 'up': {
      const at = toPanePoint(action.x, action.y, size)
      return [mouse('mouseUp', at, { button: action.button ?? 'left', clickCount: 1 })]
    }
    case 'scroll': {
      const at = toPanePoint(action.x, action.y, size)
      // Chromium's wheel delta is the way the content moves: positive deltaY
      // brings what is above into view. So is the finger's, so it passes
      // straight through, in the pane's points.
      const event: MouseWheelInputEvent = {
        type: 'mouseWheel',
        x: at.x,
        y: at.y,
        deltaX: Math.round(action.dx * size.width),
        deltaY: Math.round(action.dy * size.height),
        canScroll: true,
        hasPreciseScrollingDeltas: true
      }
      if (!event.deltaX && !event.deltaY) return []
      return [{ event }]
    }
    case 'text':
      return [{ text: action.text }]
    case 'key': {
      const keyCode = KEY_CODES[action.key]
      const modifiers: KeyboardInputEvent['modifiers'] = action.shift ? ['shift'] : []
      const steps: PaneStep[] = [{ event: { type: 'keyDown', keyCode, modifiers } }]
      // Return also types a newline (a textarea) and submits a form, which
      // Chromium does on the character, not the key going down.
      if (action.key === 'Enter') steps.push({ event: { type: 'char', keyCode: '\r', modifiers } })
      steps.push({ event: { type: 'keyUp', keyCode, modifiers } })
      return steps
    }
  }
}

/** What the module needs of a pane; the real one is a WebContents. */
export interface InputTarget {
  isDestroyed(): boolean
  sendInputEvent(event: PaneEvent): void
  insertText(text: string): Promise<void>
}

/** The buttons the phone holds down on each pane, between its `down` and `up`. */
const heldByPane = new Map<string, Set<BrowserInputButton>>()

/** Each pane's input, one action after another. */
const queues = new Map<string, Promise<void>>()

/** Longest an insert of text is waited for before the next action goes anyway. */
const TEXT_WAIT_MS = 2000

/**
 * Play one action into a pane, after the ones before it. Text is inserted on a
 * different path from the events, and a Backspace sent straight after it
 * overtook it and deleted nothing (the e2e spec caught that): so each action
 * waits for the one before to have landed.
 */
export function deliverBrowserInput(
  paneId: string,
  target: InputTarget,
  size: Size,
  action: BrowserInputAction
): Promise<void> {
  const run = async (): Promise<void> => {
    if (target.isDestroyed()) return
    const held = heldByPane.get(paneId) ?? new Set<BrowserInputButton>()
    for (const step of toPaneSteps(action, size, held)) {
      if (target.isDestroyed()) return
      if ('text' in step) {
        await Promise.race([
          target.insertText(step.text).catch(() => {}),
          new Promise((r) => setTimeout(r, TEXT_WAIT_MS))
        ])
      } else target.sendInputEvent(step.event)
    }
    if (action.type === 'down') held.add(action.button ?? 'left')
    else if (action.type === 'up' || action.type === 'click') held.delete(action.button ?? 'left')
    if (held.size) heldByPane.set(paneId, held)
    else heldByPane.delete(paneId)
  }
  const next = (queues.get(paneId) ?? Promise.resolve()).then(run, run)
  const tail = next.catch(() => {})
  queues.set(paneId, tail)
  void tail.then(() => {
    if (queues.get(paneId) === tail) queues.delete(paneId)
  })
  return next
}

/** For tests. */
export function _resetHeldButtons(): void {
  heldByPane.clear()
  queues.clear()
}
