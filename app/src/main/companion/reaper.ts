import { agentBus, listSessions, stopAgent } from '../agent'
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
  })
  agentBus.on('user', touch)
  agentBus.on('exit', ({ id }: { id: string }) => {
    lastActivity.delete(id)
    liveBackground.delete(id)
  })
  timer = setInterval(() => {
    const now = Date.now()
    for (const s of listSessions()) {
      if (s.owned || (liveBackground.get(s.id) ?? 0) > 0) continue
      const last = lastActivity.get(s.id) ?? now
      if (now - last > IDLE_MS) {
        stopAgent(s.id, 'started from the phone and idle for ten minutes')
        lastActivity.delete(s.id)
      }
    }
  }, 60_000)
  timer.unref?.()
}
