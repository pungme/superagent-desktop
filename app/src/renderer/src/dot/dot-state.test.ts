import { describe, expect, it } from 'vitest'
import {
  applyDelta,
  applyEvent,
  elapsed,
  followUp,
  newTask,
  stepLabel,
  suggestions
} from './dot-state'

const start = (): ReturnType<typeof newTask> => newTask('c1', 'w1', 'Tidy my Downloads', 1000)

describe('what the dot shows for a request', () => {
  it('starts out working, with nothing to show yet', () => {
    expect(start()).toMatchObject({ status: 'working', steps: [], answer: '', approval: null })
  })

  it('lists what the agent does, in plain words, without repeating itself', () => {
    let t = start()
    t = applyEvent(t, 'c1', { kind: 'tool', name: 'Bash', detail: 'ls -la ~/Downloads' })
    t = applyEvent(t, 'c1', { kind: 'tool', name: 'Bash', detail: 'ls -la ~/Downloads' })
    t = applyEvent(t, 'c1', { kind: 'tool', name: 'Read', detail: '/Users/me/Downloads/notes.txt' })
    expect(t.steps).toEqual(['Running a command · ls -la ~/Downloads', 'Reading · notes.txt'])
  })

  it('takes the last block of the reply as the answer, and finishes on turn end', () => {
    let t = start()
    t = applyDelta(t, 'c1', 'Looking')
    expect(t.live).toBe('Looking')
    t = applyEvent(t, 'c1', { kind: 'assistant', id: 'a1', text: 'Looking at the folder.' })
    t = applyEvent(t, 'c1', { kind: 'assistant', id: 'a2', text: 'Done: 38 duplicates moved.' })
    expect(t).toMatchObject({ answer: 'Done: 38 duplicates moved.', live: '', status: 'working' })
    t = applyEvent(t, 'c1', { kind: 'turn_end', ok: true, subtype: 'success' })
    expect(t.status).toBe('done')
  })

  it('keeps what was streaming if the turn ends before the block lands', () => {
    let t = applyDelta(start(), 'c1', 'Half an answer')
    t = applyEvent(t, 'c1', { kind: 'turn_end', ok: true, subtype: 'success' })
    expect(t).toMatchObject({ status: 'done', answer: 'Half an answer' })
  })

  it('waits on an approval, and carries on when it is answered', () => {
    let t = start()
    t = applyEvent(t, 'c1', {
      kind: 'approval',
      id: 'g1',
      toolName: 'mcp__cove-browser__mail_send',
      preview: 'Send email to caspar@example.com'
    })
    expect(t).toMatchObject({ status: 'needs', approval: { id: 'g1', handoff: false } })
    // Stuck in the browser is a different kind of waiting.
    expect(
      applyEvent(start(), 'c1', {
        kind: 'approval',
        id: 'h1',
        toolName: 'browser_ask_user',
        preview: 'Sign in to Shopify, then press Done',
        approvalKind: 'handoff'
      }).approval
    ).toMatchObject({ handoff: true })
    // Someone else's approval ending is not ours.
    expect(applyEvent(t, 'c1', { kind: 'approval_end', id: 'other' }).status).toBe('needs')
    t = applyEvent(t, 'c1', { kind: 'approval_end', id: 'g1', outcome: 'approved' })
    expect(t).toMatchObject({ status: 'working', approval: null })
  })

  it('says when it was stopped or failed', () => {
    const stopped = applyEvent(start(), 'c1', {
      kind: 'turn_end',
      ok: false,
      subtype: 'interrupted'
    })
    expect(stopped).toMatchObject({ status: 'failed', error: 'Stopped.' })
    const failed = applyEvent(start(), 'c1', { kind: 'turn_end', ok: false, subtype: 'error' })
    expect(failed.error).toBe('It stopped before finishing.')
  })

  it('ignores another chat entirely', () => {
    const t = start()
    expect(applyEvent(t, 'c2', { kind: 'turn_end', ok: true })).toBe(t)
    expect(applyDelta(t, 'c2', 'x')).toBe(t)
  })

  it('stops taking streamed text once it is over', () => {
    const done = applyEvent(start(), 'c1', { kind: 'turn_end', ok: true })
    expect(applyDelta(done, 'c1', 'late')).toBe(done)
  })
})

describe('a follow-up in the same conversation', () => {
  it('starts what is shown over, and stays the same chat', () => {
    let t = start()
    t = applyEvent(t, 'c1', { kind: 'tool', name: 'Bash', detail: 'ls' })
    t = applyEvent(t, 'c1', { kind: 'assistant', id: 'a', text: 'Done.' })
    t = applyEvent(t, 'c1', { kind: 'turn_end', ok: true })
    const next = followUp(t, 'And the Desktop?', 9000)
    expect(next).toMatchObject({
      chatId: 'c1',
      question: 'And the Desktop?',
      status: 'working',
      steps: [],
      answer: '',
      startedAt: 9000
    })
  })
  it('does not lose an approval that is still waiting', () => {
    const waiting = applyEvent(start(), 'c1', {
      kind: 'approval',
      id: 'g1',
      toolName: 'Bash',
      preview: 'rm -rf build'
    })
    expect(followUp(waiting, 'also the cache', 2000)).toMatchObject({
      status: 'needs',
      approval: { id: 'g1' }
    })
  })
})

describe('step labels', () => {
  it("names Superagent's own tools by what they act on", () => {
    expect(stepLabel('mcp__cove-browser__browser_navigate', 'https://example.com')).toBe(
      'Browser: navigate · https://example.com'
    )
    expect(stepLabel('mcp__cove-browser__sim_tap', '')).toBe('Simulator: tap')
  })
  it('cuts a long command rather than letting it run on', () => {
    const label = stepLabel(
      'Bash',
      'find ~/Downloads -type f -mtime +365 -print0 | xargs -0 ls -la'
    )
    expect(label.length).toBeLessThan(80)
    expect(label.endsWith('…')).toBe(true)
  })
})

it('counts elapsed time the way a person reads it', () => {
  expect(elapsed(42_000)).toBe('42s')
  expect(elapsed(185_000)).toBe('3m 05s')
  expect(elapsed(-5)).toBe('0s')
})

it('offers things to do on the Mac for the Computer, and questions for a project', () => {
  expect(suggestions('computer')).toContain('Tidy my Downloads folder')
  expect(suggestions('folder')).toContain('What changed here this week?')
  expect(suggestions('computer')).not.toEqual(suggestions('folder'))
})
