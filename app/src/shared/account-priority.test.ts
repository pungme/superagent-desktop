import { describe, it, expect } from 'vitest'
import { rankAccounts, nextInPriority, perAgentOrder, type Ranked } from './account-priority'
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
