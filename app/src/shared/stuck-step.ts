/**
 * Is a step stuck: has nothing it started used any CPU for a long time?
 *
 * A step that waits on something that will never answer — `find` over iCloud
 * files that are not on the Mac, a command waiting for input nobody types, a
 * network call with no timeout — sits at 0% CPU, and the chat said only
 * "Working 23380s" for six and a half hours while four messages waited behind
 * it. A slow step burns CPU; a stuck one does not. So the processes the step
 * started (under the agent, started after the step began) are sampled, and when
 * none of them has used any CPU for STUCK_AFTER_MS the step is called stuck.
 *
 * Pure: the caller reads `ps` and keeps the samples between calls.
 */

export const STUCK_AFTER_MS = 10 * 60 * 1000

export interface ProcRow {
  pid: number
  ppid: number
  /** Seconds since it started. */
  elapsed: number
  /** CPU seconds used so far. */
  cpu: number
  command: string
}

/** pid → the CPU seconds it had, and since when it has had them. */
export type Samples = Map<number, { cpu: number; since: number }>

export interface StuckStep {
  /** The step's processes, the ones a Stop would end. */
  pids: number[]
  /** What the oldest of them runs, for the chat to show. */
  command: string
  /** Since when nothing has moved. */
  idleSince: number
}

/** `ps -axo pid=,ppid=,etime=,time=,command=` → rows. */
export function parsePs(text: string): ProcRow[] {
  const out: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const elapsed = clockSeconds(m[3])
    const cpu = clockSeconds(m[4])
    if (elapsed === null || cpu === null) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), elapsed, cpu, command: m[5].trim() })
  }
  return out
}

/** "[[dd-]hh:]mm:ss[.cc]" → seconds. */
export function clockSeconds(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

/** Every process under `root`, not `root` itself. */
export function descendants(rows: ProcRow[], root: number): ProcRow[] {
  const kids = new Map<number, ProcRow[]>()
  for (const r of rows) {
    const list = kids.get(r.ppid) ?? []
    list.push(r)
    kids.set(r.ppid, list)
  }
  const out: ProcRow[] = []
  const stack = [...(kids.get(root) ?? [])]
  const seen = new Set<number>([root])
  while (stack.length) {
    const r = stack.pop()!
    if (seen.has(r.pid)) continue
    seen.add(r.pid)
    out.push(r)
    stack.push(...(kids.get(r.pid) ?? []))
  }
  return out
}

/**
 * The step's processes: under the agent and started after the step began
 * (a little slack for clocks). The agent's own long-lived helpers — MCP
 * servers, a language server — started before the step and are left out.
 */
export function stepProcesses(
  rows: ProcRow[],
  agentPid: number,
  stepSince: number,
  now: number
): ProcRow[] {
  const ageLimit = (now - stepSince) / 1000 + 5
  return descendants(rows, agentPid).filter((r) => r.elapsed <= ageLimit)
}

/**
 * Update the samples with this look and say whether the step is stuck.
 * The agent itself counts too: an agent that is still thinking is not stuck,
 * whatever its tools are doing.
 */
export function checkStuck(
  rows: ProcRow[],
  agentPid: number,
  stepSince: number,
  now: number,
  samples: Samples,
  stuckAfter = STUCK_AFTER_MS
): StuckStep | null {
  const step = stepProcesses(rows, agentPid, stepSince, now)
  const agent = rows.find((r) => r.pid === agentPid)
  const watched = agent ? [agent, ...step] : step
  const live = new Set(watched.map((r) => r.pid))
  for (const pid of [...samples.keys()]) if (!live.has(pid)) samples.delete(pid)
  let idleSince = 0
  for (const r of watched) {
    const before = samples.get(r.pid)
    // A process seen for the first time counts as idle from when it was first seen.
    if (!before || r.cpu > before.cpu + 0.05) samples.set(r.pid, { cpu: r.cpu, since: now })
    idleSince = Math.max(idleSince, samples.get(r.pid)!.since)
  }
  if (!step.length) return null
  // Not stuck until the step itself is old enough, whatever the samples say.
  if (now - stepSince < stuckAfter) return null
  if (now - idleSince < stuckAfter) return null
  const oldest = [...step].sort((a, b) => b.elapsed - a.elapsed)[0]
  return {
    pids: step.map((r) => r.pid),
    command: oldest.command.slice(0, 300),
    idleSince
  }
}
