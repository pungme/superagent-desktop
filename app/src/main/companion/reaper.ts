import { agentBus, listSessions, stopAgent } from '../agent'

/**
 * Sessions the phone started have no window to close them. The renderer reaps
 * its own idle chats after five minutes; this does the same for ownerless
 * ones, a little later, so a quick follow-up from the train still lands on a
 * warm session.
 */
const IDLE_MS = 10 * 60 * 1000
const lastActivity = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | null = null

export function startReaper(): void {
  if (timer) return
  const touch = ({ id }: { id: string }): void => {
    lastActivity.set(id, Date.now())
  }
  agentBus.on('started', touch)
  agentBus.on('event', touch)
  agentBus.on('user', touch)
  agentBus.on('exit', ({ id }: { id: string }) => lastActivity.delete(id))
  timer = setInterval(() => {
    const now = Date.now()
    for (const s of listSessions()) {
      if (s.owned) continue
      const last = lastActivity.get(s.id) ?? now
      if (now - last > IDLE_MS) {
        stopAgent(s.id)
        lastActivity.delete(s.id)
      }
    }
  }, 60_000)
  timer.unref?.()
}
