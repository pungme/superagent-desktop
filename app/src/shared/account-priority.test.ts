import { describe, it, expect } from 'vitest'
import {
  rankAccounts,
  nextInPriority,
  perAgentOrder,
  switchBackTarget,
  type Ranked
} from './account-priority'
import type { AgentProvider } from './agent-provider'

const per: Record<AgentProvider, Ranked[]> = {
  claude: [
    { id: 'c-personal', provider: 'claude' },
    { id: 'c-work', provider: 'claude' }
  ],
  codex: [{ id: 'x-plus', provider: 'codex' }],
  antigravity: [{ id: 'g-pro', provider: 'antigravity' }]
}

describe('account priority across agents', () => {
  it('without an order of your own: each agent in turn, in its own order', () => {
    expect(rankAccounts(per, undefined).map((a) => a.id)).toEqual([
      'c-personal',
      'c-work',
      'x-plus',
      'g-pro'
    ])
  })

  it('a chosen order interleaves agents; accounts it does not name come after', () => {
    const r = rankAccounts(per, ['c-personal', 'x-plus', 'gone', 'c-work'])
    expect(r.map((a) => a.id)).toEqual(['c-personal', 'x-plus', 'c-work', 'g-pro'])
    expect(perAgentOrder(r, 'claude')).toEqual(['c-personal', 'c-work'])
  })

  it('moves to the next usable account, even of another agent', () => {
    const r = rankAccounts(per, ['c-personal', 'x-plus', 'c-work', 'g-pro'])
    expect(nextInPriority(r, 'c-personal', () => true)?.id).toBe('x-plus')
    expect(nextInPriority(r, 'c-personal', (a) => a.id !== 'x-plus')?.id).toBe('c-work')
    expect(nextInPriority(r, 'c-personal', () => false)).toBeNull()
  })
})

describe('switching back when a preferred account has allowance again', () => {
  const ranked = rankAccounts(per, ['c-personal', 'x-plus', 'c-work'])
  const freeExcept =
    (...out: string[]) =>
    (a: Ranked): boolean =>
      !out.includes(a.id)

  it('goes back to the account it ran out on once that one is free', () => {
    expect(switchBackTarget(ranked, 'x-plus', freeExcept())?.id).toBe('c-personal')
  })

  it('stays while everything above it is still out', () => {
    expect(switchBackTarget(ranked, 'x-plus', freeExcept('c-personal'))).toBeNull()
  })

  it('never moves down the order', () => {
    expect(switchBackTarget(ranked, 'c-personal', freeExcept())).toBeNull()
  })

  it('moves up part of the way when only a middle account is free', () => {
    expect(switchBackTarget(ranked, 'c-work', freeExcept('c-personal'))?.id).toBe('x-plus')
  })

  it('crossed to another agent with no order across agents: back to the first agent', () => {
    // Preferred is the first agent's accounts only; the chat is on Codex now.
    expect(switchBackTarget(per.claude, 'x-plus', freeExcept('c-personal'))?.id).toBe('c-work')
    expect(switchBackTarget(per.claude, 'x-plus', freeExcept('c-personal', 'c-work'))).toBeNull()
  })
})
