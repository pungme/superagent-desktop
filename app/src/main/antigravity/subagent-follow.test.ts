import { describe, it, expect, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChildTranscript, decodeArgs, followSubagent } from './subagent-follow'
import { noteSubagentEvent, progressOf, type SubActivity } from '../../shared/subagent-activity'
import type { StreamJsonEvent } from './translate'

/** A real Antigravity sub-agent transcript (agy 1.2.16), the user name changed. */
const FIXTURE = join(__dirname, '..', '__fixtures__', 'agy-subagent-transcript.jsonl')
const lines = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('reading a sub-agent transcript', () => {
  it('turns its calls and results into events tagged with the card that started it', () => {
    const t = new ChildTranscript('agy-75de2168-2', 'k')
    const events = lines.flatMap((l) => t.feed(l))
    const calls = events.flatMap((e) =>
      ((e.message as { content?: Record<string, unknown>[] }).content ?? []).filter(
        (b) => b.type === 'tool_use'
      )
    )
    expect(events.every((e) => e.parent_tool_use_id === 'agy-75de2168-2')).toBe(true)
    // run_command → Bash with its command decoded; read_file → Read.
    expect(calls.map((c) => c.name)).toEqual(['Bash', 'Read', 'send_message'])
    expect((calls[0].input as { command: string }).command).toBe('ls -la /tmp/agy-probe')
    const results = events.flatMap((e) =>
      ((e.message as { content?: Record<string, unknown>[] }).content ?? []).filter(
        (b) => b.type === 'tool_result'
      )
    )
    expect(results.map((r) => r.tool_use_id)).toEqual(calls.map((c) => c.id))
    expect(results.every((r) => r.is_error === false)).toBe(true)
    // The timestamps agy writes in front of every result are gone.
    expect(String(results[1].content)).toBe('Showing lines 1-1 of 1\n1: hello')
    // Its last word, and that it is done.
    expect(JSON.stringify(events[events.length - 1])).toContain('Sent the file list')
    expect(t.done).toBe(true)
  })

  it('is not done while it still calls tools', () => {
    const t = new ChildTranscript('p', 'k')
    for (const l of lines.slice(0, 4)) t.feed(l)
    expect(t.done).toBe(false)
  })

  it('reads a step once, however often it is fed', () => {
    const t = new ChildTranscript('p', 'k')
    expect(t.feed(lines[1]).length).toBe(1)
    expect(t.feed(lines[1])).toEqual([])
  })

  it('marks a command that failed', () => {
    const t = new ChildTranscript('p', 'k')
    t.feed({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"false"' } }]
    })
    const [r] = t.feed({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      content: 'Command exited with code 1.\n'
    })
    expect(JSON.stringify(r)).toContain('"is_error":true')
  })

  it('decodes JSON-encoded arguments and keeps the rest', () => {
    expect(
      decodeArgs({ CommandLine: '"ls -la"', WaitMsBeforeAsync: '5000', Raw: 'not json', N: 3 })
    ).toEqual({
      CommandLine: 'ls -la',
      WaitMsBeforeAsync: 5000,
      Raw: 'not json',
      N: 3
    })
    expect(decodeArgs(null)).toEqual({})
  })

  it('feeds the panel: steps, what it said, and none still running at the end', () => {
    const t = new ChildTranscript('card', 'k')
    const activity: SubActivity = new Map()
    for (const e of lines.flatMap((l) => t.feed(l))) noteSubagentEvent(activity, e, 1)
    const steps = activity.get('card')!
    expect(steps.filter((s) => s.kind === 'tool').map((s) => s.done)).toEqual([true, true, true])
    expect(progressOf(steps)).toMatchObject({ calls: 3, waiting: 0 })
    expect(steps.some((s) => s.kind === 'text' && s.detail.includes('Sent the file list'))).toBe(
      true
    )
  })
})

describe('following a transcript as it is written', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads what is appended, and says the sub-agent finished when it is done', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cove-follow-'))
    const log = join(dir, 'transcript.jsonl')
    const events: StreamJsonEvent[] = []
    const stop = followSubagent({ toolUseId: 'card', logs: [log] }, (e) => events.push(e), {
      everyMs: 20
    })
    // Not written yet: nothing, and no error.
    await new Promise((r) => setTimeout(r, 60))
    expect(events).toEqual([])
    // The first steps, the last one cut mid-line.
    const raw = readFileSync(FIXTURE, 'utf8')
    const cut = raw.indexOf('\n', raw.search(/"step_index":\s*3/)) + 40
    writeFileSync(log, raw.slice(0, cut))
    await new Promise((r) => setTimeout(r, 80))
    const early = events.length
    expect(early).toBeGreaterThan(0)
    expect(events.some((e) => e.subtype === 'task_notification')).toBe(false)
    // The rest arrives.
    appendFileSync(log, raw.slice(cut))
    await new Promise((r) => setTimeout(r, 120))
    expect(events.length).toBeGreaterThan(early)
    const end = events.filter((e) => e.subtype === 'task_notification')
    expect(end).toEqual([{ type: 'system', subtype: 'task_notification', tool_use_id: 'card' }])
    stop()
  })

  it('stops when the session does, saying nothing more', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cove-follow-'))
    const log = join(dir, 'transcript.jsonl')
    const events: StreamJsonEvent[] = []
    const stop = followSubagent({ toolUseId: 'card', logs: [log] }, (e) => events.push(e), {
      everyMs: 20
    })
    stop()
    writeFileSync(log, readFileSync(FIXTURE, 'utf8'))
    await new Promise((r) => setTimeout(r, 80))
    expect(events).toEqual([])
  })
})
