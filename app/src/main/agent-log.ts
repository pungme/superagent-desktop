import { app } from 'electron'
import { appendFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Who started and stopped each agent, and why: one line per event in
 * userData/agents.log, rotated once at ~512 KB.
 *
 * A session ending is the commonest thing to go wrong and left nothing behind
 * to say which of a dozen code paths ended it. Twice that meant days of
 * guessing: a `pkill` in another chat, then a second agent started on a
 * conversation whose first was still running.
 */
let rotated = false
export function agentLog(event: string, id: string, detail = ''): void {
  try {
    const file = join(app.getPath('userData'), 'agents.log')
    if (!rotated) {
      rotated = true
      try {
        if (statSync(file).size > 512 * 1024) renameSync(file, file + '.old')
      } catch {
        /* first run — no log yet */
      }
    }
    appendFileSync(file, `${new Date().toISOString()} ${event} ${id.slice(0, 8)} ${detail}\n`)
  } catch {
    /* logging must never break a session */
  }
}
