import { agentBus, listSessions, stopAgent } from '../agent'
import { isGenerating } from './log'
import { liveTaskIds, type LiveTask } from '../../shared/bg-tasks'

/**
 * Sessions the phone started have no window to close them. The renderer reaps
 * its own idle chats after five minutes; this does the same for ownerless
 * ones, a little later, so a quick follow-up from the train still lands on a
 * warm session.
 */
const IDLE_MS = 10 * 60 * 1000
const lastActivity = new Map<string, number>()
/**
 * Background jobs (sub-agents included) each session has running, as its
 * last `background_tasks_changed` said. A sub-agent can work for a long time
 * without a word to the main stream; idle by events is not idle then.
 */
const liveBackground = new Map<string, number>()
/** Sub-agents announced as working in the background and not yet finished, per session. */
const backgroundAgents = new Map<string, Set<string>>()
let timer: ReturnType<typeof setInterval> | null = null

export function startReaper(): void {
  if (timer) return
  const touch = ({ id }: { id: string }): void => {
    lastActivity.set(id, Date.now())
  }
  agentBus.on('started', touch)
  agentBus.on('event', touch)
  agentBus.on('event', ({ id, event }: { id: string; event?: Record<string, unknown> }) => {
    if (event?.type === 'system' && event.subtype === 'background_tasks_changed')
      liveBackground.set(id, liveTaskIds(event as { tasks?: LiveTask[] }).size)
    // A sub-agent said to be running in the background, and its end. Antigravity
    // reports nothing else: its parent sits silent while its sub-agents work, and
    // a funding search was stopped half-way as "idle" (2026-11-25).
    const tool = typeof event?.tool_use_id === 'string' ? event.tool_use_id : null
    if (event?.type === 'system' && tool) {
      const set = backgroundAgents.get(id) ?? new Set<string>()
      if (
        event.subtype === 'task_started' &&
        event.task_type === 'local_agent' &&
        event.is_backgrounded
      )
        set.add(tool)
      if (event.subtype === 'task_notification') set.delete(tool)
      backgroundAgents.set(id, set)
    }
  })
  agentBus.on('user', touch)
  agentBus.on('exit', ({ id }: { id: string }) => {
    lastActivity.delete(id)
    liveBackground.delete(id)
    backgroundAgents.delete(id)
  })
  timer = setInterval(() => {
    const now = Date.now()
    for (const s of listSessions()) {
      if (
        s.owned ||
        (liveBackground.get(s.id) ?? 0) > 0 ||
        (backgroundAgents.get(s.id)?.size ?? 0) > 0 ||
        // A turn in progress is not idle however quiet it is: a long deploy or build prints
        // nothing for many minutes, and the session was stopped under it.
        (s.chatId ? isGenerating(s.chatId) : false)
      )
        continue
      const last = lastActivity.get(s.id) ?? now
      if (now - last > IDLE_MS) {
        stopAgent(s.id, 'started from the phone and idle for ten minutes')
        lastActivity.delete(s.id)
      }
    }
  }, 60_000)
  timer.unref?.()
}

/** Tests only: a fresh reaper, on whatever clock the test runs. */
export function _resetReaperForTests(): void {
  if (timer) clearInterval(timer)
  timer = null
  agentBus.removeAllListeners()
  lastActivity.clear()
  liveBackground.clear()
  backgroundAgents.clear()
}
