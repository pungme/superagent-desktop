import { z } from 'zod'
import type { ScreenArea } from '../../shared/computer-use'
import {
  REMOTE_KEYS,
  REMOTE_MODS,
  remotePoint,
  remoteTextOk,
  scrollPixels
} from '../../shared/remote-control'
import type { RemoteInputAction } from '../../shared/companion-protocol'

/**
 * What the phone may send (`remote.input`) and what each action becomes for the
 * helper. Everything is checked here, before any of it is looked at by the
 * guard in control.ts: unknown fields, out-of-range points, keys outside the
 * list, text with control characters, batches that are too long.
 */

const frac = z.number().finite().min(0).max(1)
const button = z.enum(['left', 'right']).optional()

const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), x: frac, y: frac }).strict(),
  z
    .object({
      type: z.literal('click'),
      x: frac,
      y: frac,
      button,
      count: z.number().int().min(1).max(3).optional()
    })
    .strict(),
  z.object({ type: z.literal('down'), x: frac, y: frac, button }).strict(),
  z.object({ type: z.literal('up'), x: frac, y: frac, button }).strict(),
  z.object({ type: z.literal('drag'), x: frac, y: frac, toX: frac, toY: frac }).strict(),
  z
    .object({
      type: z.literal('scroll'),
      x: frac,
      y: frac,
      dx: z.number().finite().min(-1).max(1),
      dy: z.number().finite().min(-1).max(1)
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      text: z.string().refine(remoteTextOk, 'printable text, 1 to 500 characters')
    })
    .strict(),
  z
    .object({
      type: z.literal('key'),
      key: z.enum(REMOTE_KEYS as [string, ...string[]]),
      mods: z.array(z.enum(REMOTE_MODS)).max(5).optional()
    })
    .strict()
])

export const remoteInputParams = z.object({ actions: z.array(action).min(1).max(32) }).strict()

export const remoteViewParams = z
  .object({
    visible: z.boolean().optional(),
    maxWidth: z.number().int().min(320).max(4000).optional(),
    key: z.boolean().optional()
  })
  .strict()

export const remoteCodeParams = z.object({ code: z.string().regex(/^\d{6}$/) }).strict()

/** What one action asks the Mac to do, for the guard: where it lands, or which keys it presses. */
export interface Step {
  /** The helper's arguments. */
  args: string[]
  /** Points it touches, in the system's coordinates (both ends of a drag). */
  points: { x: number; y: number }[]
  kind: 'pointer' | 'keys'
  /** Whether it is only the pointer moving. */
  move?: boolean
}

/** Whether a button is held down on the Mac for the phone, from its `down` to its `up`. */
export interface Held {
  button: 'left' | 'right'
  at: { x: number; y: number }
}

/**
 * The helper's arguments for one action, its points mapped onto the display.
 * `held`: a button the phone holds down, which makes a move a drag. Keys are
 * not here: they go through `remoteKey` in control.ts, which knows Superagent's
 * own shortcuts.
 */
export function toStep(
  a: Exclude<RemoteInputAction, { type: 'key' }>,
  area: ScreenArea,
  held: Held | null
): Step {
  const p = (x: number, y: number): { x: number; y: number } => remotePoint(area, x, y)
  const s = (v: { x: number; y: number }): string[] => [String(v.x), String(v.y)]
  switch (a.type) {
    case 'move': {
      const at = p(a.x, a.y)
      return {
        args: [held && held.button === 'left' ? 'dragto' : 'jump', ...s(at)],
        points: [at],
        kind: 'pointer',
        move: true
      }
    }
    case 'click': {
      const at = p(a.x, a.y)
      return {
        args: ['tap', ...s(at), a.button ?? 'left', String(a.count ?? 1)],
        points: [at],
        kind: 'pointer'
      }
    }
    case 'down': {
      const at = p(a.x, a.y)
      return {
        args: ['down', ...s(at), a.button ?? 'left'],
        points: [at],
        kind: 'pointer'
      }
    }
    case 'up': {
      const at = p(a.x, a.y)
      return { args: ['up', ...s(at), a.button ?? 'left'], points: [at], kind: 'pointer' }
    }
    case 'drag': {
      const from = p(a.x, a.y)
      const to = p(a.toX, a.toY)
      return { args: ['drag', ...s(from), ...s(to)], points: [from, to], kind: 'pointer' }
    }
    case 'scroll': {
      const at = p(a.x, a.y)
      const px = scrollPixels(area, a.dx, a.dy)
      return {
        args: ['wheel', ...s(at), String(px.dx), String(px.dy)],
        points: [at],
        kind: 'pointer'
      }
    }
    case 'text':
      return {
        args: ['type', a.text],
        points: [],
        kind: 'keys'
      }
  }
}
