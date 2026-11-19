import { describe, expect, it } from 'vitest'
import { agentsToTry } from './agent-fallback'
import type { AgentProvider } from './agent-provider'

const all = (): boolean => true
const only =
  (...ok: AgentProvider[]) =>
  (p: AgentProvider): boolean =>
    ok.includes(p)

describe('agentsToTry', () => {
  it('goes Claude, Codex, Antigravity, and round', () => {
    expect(agentsToTry('claude', all)).toEqual(['codex', 'antigravity'])
    expect(agentsToTry('codex', all)).toEqual(['antigravity', 'claude'])
    expect(agentsToTry('antigravity', all)).toEqual(['claude', 'codex'])
  })
  it('skips an agent that is not signed in or is out too', () => {
    expect(agentsToTry('claude', only('antigravity'))).toEqual(['antigravity'])
    expect(agentsToTry('codex', only('claude'))).toEqual(['claude'])
  })
  it('is empty when nothing else can take it, and never offers the current one', () => {
    expect(agentsToTry('claude', () => false)).toEqual([])
    expect(agentsToTry('claude', only('claude'))).toEqual([])
  })
})
