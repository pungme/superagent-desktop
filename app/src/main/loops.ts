import { EventEmitter } from 'events'
import { ipcMain } from 'electron'
import { agentBus, findSessionByChat, sendToAgent } from './agent'
import { isGenerating, logBus, record } from './companion/log'
import { getChat } from './store'
import { broadcastToWindows } from './util'
import {
  DEFAULT_LOOP_ROUND_GAP_MS,
  LOOP_CAP,
  LOOP_USAGE,
  MAX_LOOP_ROUND_GAP_MS,
  SELF_PACE_NOTE,
  humanInterval,
  parseLoopCmd
} from '../shared/loop'
import type { WireLoop } from '../shared/companion-protocol'

/**
 * The in-chat /loop, owned here rather than by a chat's window.
 *
 * It used to live inside the chat view, which meant the phone never knew a
 * loop was running (nor could stop or start one), and a loop died the moment
 * its chat view was unmounted. One loop per chat, kept on the Mac: the window
 * and every paired phone read the same state and either can stop it.
 */

interface Loop extends WireLoop {
  chatId: string
  /** The pending next round (continuous) or the ticking interval. */
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null
  /** Retry or watchdog for the round in flight; see fire(). */
  guard: ReturnType<typeof setTimeout> | null
  roundStart: number
  /** When an interval loop's clock started; its ticks fall on multiples from here. */
  startedAt: number
  /** Delivered, but no turn has started for it yet. */
  awaiting: boolean
  /** The model's own loop_wait for the round in progress, if it called one. */
  requestedGapMs: number | null
}

const loops = new Map<string, Loop>()

/** 'changed' (chatId) — the companion re-sends its chat list on it. */
export const loopsBus = new EventEmitter()

/** How long a window has to claim a round before another path takes it. */
const OFFER_MS = 1000
/** A round that was handed over but never started a turn is retried after this. */
const WATCHDOG_MS = 45_000
/** A window whose agent is mid-restart asked us to hold the round; try again after this. */
const BUSY_RETRY_MS = 5000

export function loopFor(chatId: string): WireLoop | null {
  const l = loops.get(chatId)
  return l ? { prompt: l.prompt, intervalMs: l.intervalMs, count: l.count, nextAt: l.nextAt } : null
}

function changed(chatId: string): void {
  broadcastToWindows('loops:changed', { chatId, loop: loopFor(chatId) })
  loopsBus.emit('changed', chatId)
}

function clearTimers(l: Loop): void {
  if (l.timer) {
    clearTimeout(l.timer as ReturnType<typeof setTimeout>)
    clearInterval(l.timer as ReturnType<typeof setInterval>)
  }
  if (l.guard) clearTimeout(l.guard)
  l.timer = null
  l.guard = null
}

/**
 * Starts the agent for a chat nobody has open — the phone's own send path.
 * Registered by the companion (see rpc.ts) to keep this module free of it.
 */
let sendUnattended: ((chatId: string, text: string) => Promise<boolean>) | null = null
export function setUnattendedSend(fn: (chatId: string, text: string) => Promise<boolean>): void {
  sendUnattended = fn
}

const offers = new Map<string, (answer: 'taken' | 'busy') => void>()

/**
 * Ask the window showing this chat to send the round as if it had been typed —
 * it keeps its own agent, recap and retry logic that way. 'none' when no window
 * has the chat open.
 */
function offerToWindow(chatId: string, text: string): Promise<'taken' | 'busy' | 'none'> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      offers.delete(nonce)
      resolve('none')
    }, OFFER_MS)
    offers.set(nonce, (answer) => {
      clearTimeout(timer)
      offers.delete(nonce)
      resolve(answer)
    })
    broadcastToWindows('loops:round', { chatId, text, nonce })
  })
}

async function deliver(chatId: string, text: string): Promise<'sent' | 'busy' | 'failed'> {
  const offered = await offerToWindow(chatId, text)
  if (offered === 'taken') return 'sent'
  if (offered === 'busy') return 'busy'
  // No window has it open. A live agent (started from the phone, or one whose
  // window closed) takes it directly; otherwise start one the way the phone does.
  const s = findSessionByChat(chatId)
  if (s && sendToAgent(s.id, text, [], { from: 'desktop', notifyOwner: true })) return 'sent'
  if (s) return 'busy'
  return (await sendUnattended?.(chatId, text)) ? 'sent' : 'failed'
}

function stopWith(chatId: string, notice: string): void {
  if (!loops.has(chatId)) return
  stopLoop(chatId)
  if (getChat(chatId)) record(chatId, { kind: 'notice', text: notice })
}

/** Run one round now: bump the count, hand the prompt over, watch that it started. */
async function fire(l: Loop): Promise<void> {
  if (loops.get(l.chatId) !== l) return
  if (!getChat(l.chatId)) {
    stopLoop(l.chatId)
    return
  }
  if (l.count >= LOOP_CAP) {
    stopWith(l.chatId, `⏹ Loop stopped after ${LOOP_CAP} runs (safety cap).`)
    return
  }
  l.count++
  l.nextAt = nextTick(l)
  l.roundStart = Date.now()
  l.requestedGapMs = null
  l.awaiting = true
  changed(l.chatId)
  const text = l.intervalMs === null ? l.prompt + SELF_PACE_NOTE : l.prompt
  const result = await deliver(l.chatId, text)
  if (loops.get(l.chatId) !== l) return
  if (result === 'failed') {
    stopWith(l.chatId, '⏹ Loop stopped: the agent for this chat could not be started.')
    return
  }
  if (result === 'busy') {
    // Not sent: give the count back and try again shortly.
    l.count--
    l.awaiting = false
    changed(l.chatId)
    if (l.guard) clearTimeout(l.guard)
    l.guard = setTimeout(() => {
      l.guard = null
      if (l.intervalMs === null) void fire(l)
    }, BUSY_RETRY_MS)
    return
  }
  // Handed over. If no turn ever starts for it (a send that got dropped), a
  // continuous loop would wait forever for a turn end, so move on regardless.
  if (l.guard) clearTimeout(l.guard)
  l.guard = setTimeout(() => {
    l.guard = null
    if (loops.get(l.chatId) === l && l.awaiting && !isGenerating(l.chatId)) {
      l.awaiting = false
      scheduleNext(l)
    }
  }, WATCHDOG_MS)
}

/** An interval loop's next tick; null for a continuous one (it has no clock). */
function nextTick(l: Loop): number | null {
  if (l.intervalMs === null) return null
  const n = Math.floor((Date.now() - l.startedAt) / l.intervalMs) + 1
  return l.startedAt + n * l.intervalMs
}

/** Continuous loops: the round is done, so queue the next after its gap. */
function scheduleNext(l: Loop): void {
  if (l.intervalMs !== null || l.timer) return
  // loop_wait, if the model called it this round, sets the target gap;
  // otherwise it's the same floor a bare ScheduleWakeup call would hit. Only
  // wait out what's left of it — a round that spent real time working never
  // waits twice.
  const target = l.requestedGapMs ?? DEFAULT_LOOP_ROUND_GAP_MS
  const delay = Math.max(900, target - (Date.now() - l.roundStart))
  l.nextAt = Date.now() + delay
  l.timer = setTimeout(() => {
    l.timer = null
    // A turn someone else started is still running; its end schedules us again.
    if (isGenerating(l.chatId)) {
      l.nextAt = null
      changed(l.chatId)
      return
    }
    void fire(l)
  }, delay)
  changed(l.chatId)
}

export function startLoop(chatId: string, prompt: string, intervalMs: number | null): void {
  stopLoop(chatId)
  const l: Loop = {
    chatId,
    prompt,
    intervalMs,
    count: 0,
    nextAt: null,
    timer: null,
    guard: null,
    roundStart: 0,
    startedAt: Date.now(),
    awaiting: false,
    requestedGapMs: null
  }
  loops.set(chatId, l)
  if (intervalMs !== null) {
    l.timer = setInterval(() => {
      // Skip a tick while a turn is still running, so runs don't pile up.
      if (isGenerating(chatId)) {
        l.nextAt = nextTick(l)
        changed(chatId)
        return
      }
      void fire(l)
    }, intervalMs)
  }
  void fire(l)
}

export function stopLoop(chatId: string): boolean {
  const l = loops.get(chatId)
  if (!l) return false
  clearTimers(l)
  loops.delete(chatId)
  changed(chatId)
  return true
}

/**
 * A typed `/loop …` from any device. Returns what to tell the person — the
 * window shows it as a system line; the phone gets it as a notice.
 */
export function loopCommand(chatId: string, text: string): string | null {
  const cmd = parseLoopCmd(text)
  if (!cmd) return null
  if (cmd.kind === 'usage') return LOOP_USAGE
  if (cmd.kind === 'stop') {
    return stopLoop(chatId) ? '⏹ Loop stopped.' : 'No loop is running in this chat.'
  }
  if (!cmd.prompt) return LOOP_USAGE
  startLoop(chatId, cmd.prompt, cmd.intervalMs)
  return cmd.intervalMs
    ? `🔁 Looping every ${humanInterval(cmd.intervalMs)}: “${cmd.prompt}”. Stop anytime.`
    : `🔁 Looping: “${cmd.prompt}” — self-paced: the agent decides when each next round runs. Stop anytime.`
}

/** The model's loop_wait call (mcp.ts): the gap before this chat's next round. */
export function requestLoopWait(chatId: string, delaySeconds: number): void {
  const l = loops.get(chatId)
  if (!l) return
  l.requestedGapMs = Math.min(
    MAX_LOOP_ROUND_GAP_MS,
    Math.max(DEFAULT_LOOP_ROUND_GAP_MS, delaySeconds * 1000)
  )
}

let wired = false
export function registerLoops(): void {
  if (wired) return
  wired = true
  logBus.on('busy', ({ chatId }: { chatId?: string }) => {
    const l = chatId ? loops.get(chatId) : undefined
    if (!l) return
    if (isGenerating(l.chatId)) {
      l.awaiting = false
      return
    }
    scheduleNext(l)
  })
  // Stopping the agent mid-turn is taking over: the loop ends with it, rather
  // than silently never firing again.
  agentBus.on('interrupted', ({ chatId }: { chatId?: string }) => {
    if (chatId) stopWith(chatId, '⏹ Loop stopped: the agent was interrupted.')
  })
  ipcMain.handle('loops:command', (_e, chatId: string, text: string) => loopCommand(chatId, text))
  ipcMain.handle('loops:stop', (_e, chatId: string) => stopLoop(chatId))
  ipcMain.handle('loops:get', (_e, chatId: string) => loopFor(chatId))
  ipcMain.on('loops:round-reply', (_e, nonce: string, answer: 'taken' | 'busy') =>
    offers.get(nonce)?.(answer)
  )
}

/** For tests. */
export function _resetLoopsForTests(): void {
  for (const id of [...loops.keys()]) stopLoop(id)
  offers.clear()
}
