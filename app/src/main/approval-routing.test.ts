import { expect, it, vi } from 'vitest'
vi.mock('./store', () => ({
  getChatIdBySession: (id: string) => (id === 'provider-session' ? 'chat-1' : undefined)
}))
vi.mock('./util', () => ({ broadcastToWindows: vi.fn() }))
import { broadcastToWindows } from './util'
import { requestApproval, resolveGate } from './hooks'
import { clearTurn, gateDecision, markTainted } from './guardrail'

it('shows an approval under the chat while retaining trust under the provider session', async () => {
  markTainted('provider-session')
  const pending = requestApproval(
    'ws',
    'provider-session',
    'mcp__cove-browser__mail_draft',
    'Save draft'
  )
  const [, payload] = vi.mocked(broadcastToWindows).mock.calls.at(-1)!
  expect(payload).toMatchObject({ sessionId: 'chat-1', toolName: 'mcp__cove-browser__mail_draft' })
  expect(resolveGate((payload as { requestId: string }).requestId, true, true, 'desktop')).toBe(
    true
  )
  expect(await pending).toBe(true)
  expect(gateDecision('provider-session', 'Bash')).toBe('allow')
  clearTurn('provider-session')
})
it('preserves callers already using a chat id, and returns denial', async () => {
  const pending = requestApproval('ws', 'chat-1', 'Bash', 'command', 'permission')
  const [, payload] = vi.mocked(broadcastToWindows).mock.calls.at(-1)!
  expect(payload).toMatchObject({ sessionId: 'chat-1' })
  resolveGate((payload as { requestId: string }).requestId, false, false, 'desktop')
  expect(await pending).toBe(false)
})
