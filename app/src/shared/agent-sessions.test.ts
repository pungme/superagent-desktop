import { describe, it, expect } from 'vitest'
import { swapSessions, type AgentSessions } from './agent-sessions'

describe('switching a chat between agents', () => {
  it('keeps the thread of the agent it leaves, and gives none to a newcomer', () => {
    const { next, back } = swapSessions({}, 'claude', 'codex', 'claude-1', 4)
    expect(back).toBeNull()
    expect(next.kept?.claude).toEqual({ id: 'claude-1', items: 4 })
    expect(next.resumeNext).toBeUndefined()
    expect(next.catchUpFrom).toBeUndefined()
  })

  it('gives an agent its own thread back, with where its catch-up starts', () => {
    const away = swapSessions({}, 'claude', 'codex', 'claude-1', 4).next
    const { next, back } = swapSessions(away, 'codex', 'claude', 'codex-1', 9)
    expect(back).toBe('claude-1')
    expect(next.resumeNext).toBe('claude-1')
    expect(next.catchUpFrom).toBe(4)
    expect(next.kept?.claude).toBeUndefined()
    expect(next.kept?.codex).toEqual({ id: 'codex-1', items: 9 })
  })

  it('works across three agents', () => {
    let v: AgentSessions = {}
    v = swapSessions(v, 'claude', 'codex', 'c1', 2).next
    v = swapSessions(v, 'codex', 'antigravity', 'x1', 5).next
    const r = swapSessions(v, 'antigravity', 'claude', 'g1', 7)
    expect(r.back).toBe('c1')
    expect(r.next.catchUpFrom).toBe(2)
    expect(Object.keys(r.next.kept ?? {}).sort()).toEqual(['antigravity', 'codex'])
  })

  it('keeps nothing for an agent that had not started a thread yet', () => {
    const { next } = swapSessions({}, 'claude', 'codex', null, 0)
    expect(next.kept).toEqual({})
  })

  it('changes nothing for a "switch" to the same agent', () => {
    const v = swapSessions({}, 'claude', 'codex', 'c1', 2).next
    const r = swapSessions(v, 'codex', 'codex', 'x1', 3)
    expect(r.back).toBeNull()
    expect(r.next.kept?.codex).toBeUndefined()
  })

  it('does not change the record it was given', () => {
    const v: AgentSessions = { kept: { claude: { id: 'c1', items: 1 } } }
    swapSessions(v, 'codex', 'claude', 'x1', 3)
    expect(v).toEqual({ kept: { claude: { id: 'c1', items: 1 } } })
  })

  it('gives an agent the model it had picked, not the one picked for the other agent', () => {
    const away = swapSessions({}, 'claude', 'codex', 'claude-1', 4, 'opus').next
    const codex = swapSessions(away, 'codex', 'claude', 'codex-1', 9, 'gpt-5.5')
    expect(codex.model).toBe('opus')
    // And Codex gets its own back the next time.
    const again = swapSessions(codex.next, 'claude', 'codex', 'claude-2', 12, 'sonnet')
    expect(again.model).toBe('gpt-5.5')
  })

  it('an agent that never ran this chat starts on its own default', () => {
    expect(swapSessions({}, 'claude', 'codex', 'c1', 2, 'opus').model).toBeNull()
  })

  it('keeps the pick of an agent that never started a thread, without a session to resume', () => {
    const away = swapSessions({}, 'claude', 'codex', null, 0, 'opus').next
    expect(away.kept?.claude).toEqual({ id: '', items: 0, model: 'opus' })
    const back = swapSessions(away, 'codex', 'claude', null, 0, null)
    expect(back.model).toBe('opus')
    expect(back.back).toBeNull()
    expect(back.next.resumeNext).toBeUndefined()
    expect(back.next.catchUpFrom).toBeUndefined()
  })

  it('keeps nothing for an agent with neither a thread nor a model', () => {
    expect(swapSessions({}, 'claude', 'codex', null, 0, null).next.kept).toEqual({})
  })
})
