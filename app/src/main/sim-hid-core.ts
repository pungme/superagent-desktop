import { spawn, execFile, ChildProcessWithoutNullStreams } from 'child_process'

/**
 * Input for the simulator the way Xcode 27 takes it: `native/siminput`.
 * No Electron in here: it runs in the simulator-input process (see
 * sim-input-worker.ts), off the main thread, and in main as a fallback.
 *
 * From Xcode 27 every simulator runs `dtuhidd`, and input sent the old way
 * (baguette's Indigo messages) is thrown away once anything has attached to
 * the device — reported as delivered, with nothing happening. siminput talks
 * to dtuhidd itself. It refuses to start where there is no dtuhidd (an older
 * Xcode), and then the caller falls back to baguette, which is right there.
 *
 * One warm helper per device: a tap is a line down a pipe, not a process.
 */

export interface HidAction {
  type: string
  [k: string]: unknown
}
export interface HidResult {
  ok: boolean
  error?: string
}

interface Session {
  proc: ChildProcessWithoutNullStreams
  ready: Promise<boolean>
  pending: Map<number, (r: HidResult) => void>
}

const sessions = new Map<string, Session>()
/** Devices where siminput said no: an older Xcode, or dtuhidd never answered. */
const refused = new Map<string, number>()
/** How long a refusal stands before trying again (a device still booting comes good). */
const REFUSAL_MS = 60_000
let nextId = 1

function session(bin: string | null, udid: string): Session | null {
  const live = sessions.get(udid)
  if (live && live.proc.exitCode === null && !live.proc.killed) return live
  const at = refused.get(udid)
  if (at && Date.now() - at < REFUSAL_MS) return null
  if (!bin) return null
  const proc = spawn(bin, ['--udid', udid], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, (r: HidResult) => void>()
  let settle: (ok: boolean) => void = () => {}
  const ready = new Promise<boolean>((resolve) => (settle = resolve))
  // dtuhidd can take a while to answer on a device that is still coming up.
  const startTimer = setTimeout(() => {
    settle(false)
    refused.set(udid, Date.now())
    proc.kill()
  }, 25_000)
  let buf = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      let msg: { type?: string; id?: number; ok?: boolean; error?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === 'ready') {
        clearTimeout(startTimer)
        settle(true)
      } else if (msg.type === 'error') {
        clearTimeout(startTimer)
        console.log(`[siminput] ${udid.slice(0, 8)}: ${msg.error}`)
        refused.set(udid, Date.now())
        settle(false)
      } else if (typeof msg.id === 'number') {
        const done = pending.get(msg.id)
        pending.delete(msg.id)
        done?.({ ok: !!msg.ok, error: msg.error })
      }
    }
  })
  const die = (): void => {
    clearTimeout(startTimer)
    settle(false)
    if (sessions.get(udid)?.proc === proc) sessions.delete(udid)
    for (const done of pending.values()) done({ ok: false, error: 'session-ended' })
    pending.clear()
  }
  proc.on('exit', die)
  proc.on('error', die)
  const s: Session = { proc, ready, pending }
  sessions.set(udid, s)
  return s
}

function send(s: Session, cmd: Record<string, unknown>): Promise<HidResult> {
  return new Promise((resolve) => {
    const id = nextId++
    // Long enough for a slow swipe or a paragraph of text; never forever.
    const timer = setTimeout(() => {
      s.pending.delete(id)
      resolve({ ok: false, error: 'timeout' })
    }, 15_000)
    s.pending.set(id, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    s.proc.stdin.write(JSON.stringify({ ...cmd, id }) + '\n')
  })
}

export function endHidSession(udid: string): void {
  const s = sessions.get(udid)
  if (!s) return
  sessions.delete(udid)
  try {
    s.proc.stdin.end()
    s.proc.kill()
  } catch {
    /* already gone */
  }
}

export function stopAllHid(): void {
  for (const udid of [...sessions.keys()]) endHidSession(udid)
}

/** Keys by the names the pane and the tools use, as HID keyboard usages. */
export const KEY_USAGES: Record<string, number> = {
  Enter: 0x28,
  Return: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52
}
const MODIFIER_USAGES: Record<string, number> = {
  control: 0xe0,
  ctrl: 0xe0,
  shift: 0xe1,
  option: 0xe2,
  alt: 0xe2,
  command: 0xe3,
  cmd: 0xe3
}
/** Hardware buttons, as consumer-page usages. */
export const BUTTON_USAGES: Record<string, number> = { home: 0x40, lock: 0x30, side: 0x30 }

export function modifierUsages(mods: unknown): number[] {
  const list = Array.isArray(mods) ? mods : typeof mods === 'string' ? mods.split(/[\s,+]+/) : []
  return list
    .map((m) => MODIFIER_USAGES[String(m).toLowerCase()])
    .filter((u): u is number => typeof u === 'number')
}

/** Points in a width×height space → the 0…1 the digitizer takes. */
export function normalise(
  x: unknown,
  y: unknown,
  w: unknown,
  h: unknown
): { x: number; y: number } {
  const W = Number(w) || 1
  const H = Number(h) || 1
  return { x: Number(x) / W, y: Number(y) / H }
}

/**
 * The command siminput takes for a pane or tool action, or null for one it
 * does not handle (orientation; a key name it does not know).
 */
export function hidCommand(a: HidAction): Record<string, unknown> | null {
  switch (a.type) {
    case 'tap': {
      const p = normalise(a.x, a.y, a.width, a.height)
      return { type: 'tap', ...p, hold: Number(a.duration) || 0.05 }
    }
    case 'touch': {
      const p = normalise(a.x, a.y, a.width, a.height)
      return { type: 'touch', phase: a.phase, ...p }
    }
    case 'swipe': {
      const from = normalise(a.x, a.y, a.width, a.height)
      const to = normalise(a.toX, a.toY, a.width, a.height)
      return {
        type: 'swipe',
        ...from,
        toX: to.x,
        toY: to.y,
        duration: Number(a.duration) || 0.25
      }
    }
    case 'key': {
      const usage = KEY_USAGES[String(a.code)]
      return usage ? { type: 'key', usage, mods: modifierUsages(a.modifiers) } : null
    }
    case 'press': {
      if (a.button === 'app-switcher') return { type: 'button', page: 0x0c, usage: 0x40, count: 2 }
      const usage = BUTTON_USAGES[String(a.button)]
      return usage ? { type: 'button', page: 0x0c, usage } : null
    }
    case 'text':
      return { type: 'text', text: String(a.text ?? '') }
    case 'hinge': {
      const angle = Number(a.angle)
      return angle >= 0 && angle <= 180 ? { type: 'hinge', angle } : null
    }
    default:
      return null
  }
}

/**
 * Send an action through dtuhidd. Null when this path does not apply (no
 * helper, an older Xcode, an action it does not take): the caller uses the old
 * path then. A result when it was tried, even if it failed.
 */
export async function sendHidWith(
  bin: string | null,
  udid: string,
  action: HidAction
): Promise<HidResult | null> {
  const cmd = hidCommand(action)
  if (!cmd) return null
  const s = session(bin, udid)
  if (!s || !(await s.ready)) return null
  const res = await send(s, cmd)
  // Text beyond ASCII has no key to press: put it on the device's pasteboard
  // and paste it, which is what a person would do.
  if (!res.ok && res.error === 'non-ascii') {
    try {
      await new Promise<void>((resolve, reject) => {
        const p = execFile('xcrun', ['simctl', 'pbcopy', udid], (err) =>
          err ? reject(err) : resolve()
        )
        p.stdin?.end(String(action.text ?? ''))
      })
      return send(s, { type: 'key', usage: 0x19, mods: [0xe3] })
    } catch (err) {
      return { ok: false, error: `could not paste: ${String(err).slice(0, 120)}` }
    }
  }
  return res
}

/**
 * Whether this device takes input through dtuhidd: then the pane can send a
 * finger down, moving and up as it happens instead of whole swipes.
 */
export async function hidReadyWith(bin: string | null, udid: string): Promise<boolean> {
  const s = session(bin, udid)
  return !!s && (await s.ready)
}
