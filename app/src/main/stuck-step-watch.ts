import { execFile } from 'child_process'
import { app } from 'electron'
import {
  checkStuck,
  parsePs,
  stepProcesses,
  type ProcRow,
  type Samples,
  type StuckStep
} from '../shared/stuck-step'

/**
 * The main-process side of the stuck-step watch (shared/stuck-step.ts): reads
 * `ps`, keeps each session's samples, and ends a stuck step's processes when
 * asked. What it ends is always worked out again here, from a fresh `ps`: the
 * processes under that session's agent that started after its step did. The
 * window never names a pid.
 */

const samples = new Map<string, Samples>()

/** Ten minutes; a test run (unpackaged only) may make it seconds. */
function stuckAfter(): number | undefined {
  const ms = Number(process.env.COVE_E2E_STUCK_MS)
  return !app.isPackaged && ms > 0 ? ms : undefined
}

function readPs(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,etime=,time=,command='],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parsePs(String(stdout)))
    )
  })
}

export async function stepStuck(
  sessionId: string,
  agentPid: number | undefined,
  stepSince: number
): Promise<StuckStep | null> {
  if (!agentPid || !Number.isFinite(stepSince)) return null
  const key = `${sessionId}:${stepSince}`
  // One step's samples at a time per session: a new step starts afresh.
  for (const k of [...samples.keys()])
    if (k.startsWith(`${sessionId}:`) && k !== key) samples.delete(k)
  const mine = samples.get(key) ?? new Map()
  samples.set(key, mine)
  return checkStuck(await readPs(), agentPid, stepSince, Date.now(), mine, stuckAfter())
}

/** End the step's processes: a polite TERM, then KILL for what is still there. */
export async function stopStep(agentPid: number | undefined, stepSince: number): Promise<number> {
  if (!agentPid || !Number.isFinite(stepSince)) return 0
  const pids = stepProcesses(await readPs(), agentPid, stepSince, Date.now()).map((r) => r.pid)
  const signal = (sig: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  setTimeout(() => signal('SIGKILL'), 3000).unref()
  return pids.length
}

export function forgetStuckSamples(sessionId: string): void {
  for (const k of [...samples.keys()]) if (k.startsWith(`${sessionId}:`)) samples.delete(k)
}
