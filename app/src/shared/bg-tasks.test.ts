import { describe, it, expect } from 'vitest'
import {
  BG_GRACE_MS,
  BG_QUIET_MS,
  MAX_BACKGROUND_TASKS,
  ageLabel,
  backgroundCapVerdict,
  duplicatesOf,
  groupTasks,
  isQuiet,
  liveShellTasks,
  reconcileTasks,
  type TrackedTask
} from './bg-tasks'

const T0 = 1_000_000
const task = (id: string, over: Partial<TrackedTask> = {}): TrackedTask => ({
  toolUseId: id,
  command: `cmd ${id}`,
  startedAt: T0,
  kind: 'task',
  ...over
})

describe('reconcileTasks', () => {
  it('drops a pill whose task id the CLI no longer lists', () => {
    const tasks = [task('a', { taskId: 'b1' }), task('b', { taskId: 'b2' })]
    const out = reconcileTasks(tasks, [{ task_id: 'b2' }], T0 + BG_GRACE_MS + 1, true)
    expect(out.map((t) => t.toolUseId)).toEqual(['b'])
  })

  it('keeps a task that is just starting, listed or not (grace)', () => {
    const tasks = [task('a', { taskId: 'b1' }), task('b')]
    expect(reconcileTasks(tasks, [], T0 + 1000, true)).toBe(tasks)
  })

  it('drops a pill that never got an id once the grace is over, but only when ids are proven', () => {
    const tasks = [task('a')]
    const late = T0 + BG_GRACE_MS + 1
    expect(reconcileTasks(tasks, [], late, true)).toEqual([])
    expect(reconcileTasks(tasks, [], late, false)).toBe(tasks)
  })

  it('adopts a live task with the same description when no id arrived', () => {
    const tasks = [task('a', { description: 'Watch deploy' })]
    const out = reconcileTasks(
      tasks,
      [{ task_id: 'zz', task_type: 'monitor', description: 'Watch deploy' }],
      T0 + BG_GRACE_MS + 1,
      true
    )
    expect(out[0].taskId).toBe('zz')
  })

  it('never touches a manual pill (no CLI task behind it)', () => {
    const tasks = [task('a', { kind: 'manual' })]
    expect(reconcileTasks(tasks, [], T0 + 99 * BG_GRACE_MS, true)).toBe(tasks)
  })

  it('returns the same array when nothing changed', () => {
    const tasks = [task('a', { taskId: 'x' })]
    expect(reconcileTasks(tasks, [{ task_id: 'x' }], T0 + 10 * BG_GRACE_MS, true)).toBe(tasks)
  })

  it('replays the real event shapes: five watchers, the CLI lists two', () => {
    // shapes from the CLI schema (task_started, background_tasks_changed)
    const started = ['t1', 't2', 't3', 't4', 't5'].map((id, i) => ({
      subtype: 'task_started',
      task_id: `bx${i}`,
      tool_use_id: `toolu_${id}`,
      task_type: 'local_bash',
      description: 'Watch v8.6.2 pipeline'
    }))
    let pills: TrackedTask[] = started.map((e) =>
      task(e.tool_use_id, { taskId: e.task_id, description: e.description })
    )
    const changed = {
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'bx3', task_type: 'local_bash', description: 'Watch v8.6.2 pipeline' },
        { task_id: 'bx4', task_type: 'local_agent', description: 'a sub-agent' }
      ]
    }
    pills = reconcileTasks(pills, liveShellTasks(changed), T0 + 60_000, true)
    expect(pills.map((p) => p.taskId)).toEqual(['bx3'])
    // an empty list (all finished) clears the strip
    expect(reconcileTasks(pills, liveShellTasks({ tasks: [] }), T0 + 60_000, true)).toEqual([])
  })
})

describe('groupTasks and duplicatesOf', () => {
  const five = [1, 2, 3, 4, 5].map((i) =>
    task(`w${i}`, { description: 'Keep streaming the prod v8.6.2 watch', startedAt: T0 + i })
  )
  it('collapses the same description into one group, newest first', () => {
    const g = groupTasks([...five, task('x', { description: 'other' })])
    expect(g).toHaveLength(2)
    expect(g[0].all).toHaveLength(5)
    expect(g[0].head.toolUseId).toBe('w5')
  })
  it('treats the later-listed one as newer when they started in the same millisecond', () => {
    const g = groupTasks([task('a', { description: 'same' }), task('b', { description: 'same' })])
    expect(g[0].head.toolUseId).toBe('b')
  })
  it('ignores case and spacing', () => {
    expect(
      groupTasks([task('a', { description: 'A  b' }), task('b', { description: 'a b' })])
    ).toHaveLength(1)
  })
  it('lists the older copies, keeping the newest', () => {
    expect(duplicatesOf(five).map((t) => t.toolUseId)).toEqual(['w4', 'w3', 'w2', 'w1'])
    expect(duplicatesOf([task('a'), task('b')])).toEqual([])
  })
})

describe('isQuiet and ageLabel', () => {
  it('flags only a job nothing can reconcile, after the quiet period', () => {
    const m = task('m', { kind: 'manual' })
    expect(isQuiet(m, T0 + BG_QUIET_MS - 1)).toBe(false)
    expect(isQuiet(m, T0 + BG_QUIET_MS)).toBe(true)
    expect(isQuiet({ ...m, outputAt: T0 + BG_QUIET_MS }, T0 + BG_QUIET_MS)).toBe(false)
    expect(isQuiet(task('t', { taskId: 'x' }), T0 + 9 * BG_QUIET_MS)).toBe(false)
  })
  it('reads real time, never 0s', () => {
    expect(ageLabel(T0, T0)).toBe('1s')
    expect(ageLabel(T0, T0 + 45_000)).toBe('45s')
    expect(ageLabel(T0, T0 + 5 * 60_000)).toBe('5m')
    expect(ageLabel(T0, T0 + 3 * 3600_000)).toBe('3h')
  })
})

describe('backgroundCapVerdict', () => {
  const bg = { command: 'x', run_in_background: true }
  it('refuses a new background Bash or Monitor at the cap, and says what to do', () => {
    const v = backgroundCapVerdict('Bash', bg, MAX_BACKGROUND_TASKS)
    expect(v).toContain(`already have ${MAX_BACKGROUND_TASKS} background tasks`)
    expect(v).toContain('TaskStop')
    expect(backgroundCapVerdict('Monitor', {}, MAX_BACKGROUND_TASKS + 2)).not.toBeNull()
  })
  it('lets it through under the cap', () => {
    expect(backgroundCapVerdict('Bash', bg, MAX_BACKGROUND_TASKS - 1)).toBeNull()
  })
  it('never refuses a foreground command or another tool', () => {
    expect(backgroundCapVerdict('Bash', { command: 'ls' }, 99)).toBeNull()
    expect(backgroundCapVerdict('Bash', { command: 'ls', run_in_background: false }, 99)).toBeNull()
    expect(backgroundCapVerdict('Edit', {}, 99)).toBeNull()
  })
})
