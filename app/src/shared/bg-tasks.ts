/**
 * Background work an agent leaves running ("Running in background" strip).
 *
 * Pure, and shared: the chat's strip reconciles and groups with it, and main
 * (the PreToolUse hook) counts with it, so both read "how many are running" the
 * same way.
 *
 * What the Claude CLI tells us (stream-json, checked against the CLI's own
 * schema, 2.1.314):
 *  - `system/task_started`   { task_id, tool_use_id?, task_type, description, is_backgrounded? }
 *    `task_type` is local_agent, local_bash, a monitor kind, … `tool_use_id` is the id of
 *    the Bash/Monitor/Agent call, which is how a pill (keyed by that id) learns its task_id.
 *  - `system/background_tasks_changed` { tasks: [{ task_id, task_type, description, … }] }
 *    the FULL set of live tasks, replace semantics, per process, nothing at startup.
 *  - `system/task_notification` / `task_updated` say one task ended.
 * Codex and Antigravity send none of these, so their pills are never reconciled.
 */

/**
 * Most Bash/Monitor tasks an agent may have running in one chat. A fifth start
 * is refused until it stops one. Four is room for a dev server, a log tail and
 * a deploy watch; the ghost strip that prompted this had seven.
 */
export const MAX_BACKGROUND_TASKS = 4

/** A task just started is not dropped for being missing from the live list yet. */
export const BG_GRACE_MS = 20_000

/** A job nothing can reconcile that has printed nothing for this long is called out. */
export const BG_QUIET_MS = 20 * 60_000

/** What a pill is, which decides how it can be checked. */
export type BgKind =
  /** A run_in_background Bash or a Monitor: a CLI task with an id, stoppable with TaskStop. */
  | 'task'
  /** A `… &` in a foreground Bash, or a Codex process: no CLI task, no id. */
  | 'manual'

export interface TrackedTask {
  toolUseId: string
  /** The CLI's id for the task, once task_started said it. */
  taskId?: string
  kind?: BgKind
  command: string
  description?: string
  startedAt: number
  output?: string
  outputAt?: number
}

export interface LiveTask {
  task_id?: string
  task_type?: string
  description?: string
}

/** The live tasks of a `background_tasks_changed` event, minus sub-agents. */
export function liveShellTasks(event: { tasks?: LiveTask[] }): LiveTask[] {
  return (event.tasks ?? []).filter(
    (t) => typeof t.task_id === 'string' && t.task_type !== 'local_agent'
  )
}

/**
 * Drop the pills whose task the CLI says is gone.
 *
 * - A pill with a task id stays only while that id is live.
 * - A `task` pill with no id yet may be one the CLI registered under a
 *   description of the same words; otherwise it is dropped once it is past the
 *   grace period, but only when `idsKnown` (this process has already shown that
 *   its tasks carry the tool_use_id that links them). Without that proof a miss
 *   proves nothing, and the pill stays.
 * - A `manual` pill is not a CLI task and is never touched here.
 *
 * Returns the same array when nothing changed.
 */
export function reconcileTasks<T extends TrackedTask>(
  tasks: T[],
  live: LiveTask[],
  now: number,
  idsKnown: boolean,
  graceMs: number = BG_GRACE_MS
): T[] {
  const liveIds = new Set(live.map((t) => t.task_id))
  const claimed = new Set(tasks.map((t) => t.taskId).filter(Boolean))
  let changed = false
  const next: T[] = []
  for (const t of tasks) {
    if (t.kind === 'manual') {
      next.push(t)
      continue
    }
    const young = now - t.startedAt < graceMs
    if (t.taskId) {
      if (liveIds.has(t.taskId) || young) next.push(t)
      else changed = true
      continue
    }
    const mate = live.find(
      (l) =>
        l.task_id &&
        !claimed.has(l.task_id) &&
        l.task_type !== 'local_agent' &&
        !!t.description &&
        l.description === t.description
    )
    if (mate) {
      claimed.add(mate.task_id)
      next.push({ ...t, taskId: mate.task_id })
      changed = true
      continue
    }
    if (young || !idsKnown) next.push(t)
    else changed = true
  }
  return changed ? next : tasks
}

/** What a pill is called, for grouping: the agent's words, else the command. */
function nameOf(t: { description?: string; command: string }): string {
  return (t.description || t.command).trim().replace(/\s+/g, ' ').toLowerCase()
}

export interface TaskGroup<T> {
  /** The newest of the group: the one the pill shows and the one that is kept. */
  head: T
  /** Every member, newest first. */
  all: T[]
}

/** Collapse tasks with the same name into one, newest first as the head. Order of first sight is kept. */
export function groupTasks<T extends TrackedTask>(tasks: T[]): TaskGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const t of tasks) {
    const key = nameOf(t)
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  return [...groups.values()].map((members) => {
    // Same millisecond: the one listed later started later.
    const all = members
      .map((t, i) => ({ t, i }))
      .sort((a, b) => b.t.startedAt - a.t.startedAt || b.i - a.i)
      .map((x) => x.t)
    return { head: all[0], all }
  })
}

/** The older copies of every duplicated task: what "Stop duplicates" ends. */
export function duplicatesOf<T extends TrackedTask>(tasks: T[]): T[] {
  return groupTasks(tasks).flatMap((g) => g.all.slice(1))
}

/** True when a job nothing reconciles has printed nothing for a long time. */
export function isQuiet(t: TrackedTask, now: number): boolean {
  if (t.kind !== 'manual' && t.taskId) return false
  return now - (t.outputAt ?? t.startedAt) >= BG_QUIET_MS
}

/** Age label of a pill: "12s", "3m", "2h". Seconds are never 0. */
export function ageLabel(startedAt: number, now: number): string {
  const s = Math.max(1, Math.round((now - startedAt) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

/** Does this tool call start background work that the cap applies to? */
export function startsBackgroundTask(toolName: string, input: unknown): boolean {
  if (toolName === 'Monitor') return true
  return (
    toolName === 'Bash' &&
    (input as { run_in_background?: unknown } | null)?.run_in_background === true
  )
}

/**
 * Why a new background task is refused, or null to let it start. `running` is
 * the chat's reconciled count of Bash/Monitor tasks.
 */
export function backgroundCapVerdict(
  toolName: string,
  input: unknown,
  running: number,
  max: number = MAX_BACKGROUND_TASKS
): string | null {
  if (!startsBackgroundTask(toolName, input) || running < max) return null
  return (
    `Blocked by Superagent: you already have ${running} background tasks running in this chat ` +
    `(the limit is ${max}). Stop the ones that have finished or that duplicate another with ` +
    'TaskStop first, then start the new one. Do not start another watcher for something you are already watching.'
  )
}
