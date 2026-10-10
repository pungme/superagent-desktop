import { expect, it, vi } from 'vitest'
vi.mock('./store', () => ({
  getChatIdBySession: (id: string) => (id === 'provider-session' ? 'chat-1' : undefined)
}))
vi.mock('./util', () => ({ broadcastToWindows: vi.fn() }))
import { broadcastToWindows } from './util'
import { gateIsMacOnly, requestApproval, resolveGate } from './hooks'
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
it('lets only the Mac say yes to using the Mac, while a no can come from the phone', async () => {
  const ask = (): { pending: Promise<boolean>; id: string } => {
    const pending = requestApproval(
      'ws',
      'chat-1',
      'mcp__cove-browser__computer_use',
      'Use this Mac',
      'permission'
    )
    const [, payload] = vi.mocked(broadcastToWindows).mock.calls.at(-1)!
    return { pending, id: (payload as { requestId: string }).requestId }
  }
  // A yes from the phone is not taken, and the request is still waiting.
  const a = ask()
  expect(gateIsMacOnly(a.id)).toBe(true)
  expect(resolveGate(a.id, true, false, 'ios')).toBe(false)
  expect(gateIsMacOnly(a.id)).toBe(true)
  expect(resolveGate(a.id, true, false, 'desktop')).toBe(true)
  expect(await a.pending).toBe(true)

  // A no is always safe to take, from anywhere.
  const b = ask()
  expect(resolveGate(b.id, false, false, 'ios')).toBe(true)
  expect(await b.pending).toBe(false)

  // Other requests are the phone's to answer as before.
  const pending = requestApproval('ws', 'chat-1', 'Bash', 'ls', 'permission')
  const [, payload] = vi.mocked(broadcastToWindows).mock.calls.at(-1)!
  const id = (payload as { requestId: string }).requestId
  expect(gateIsMacOnly(id)).toBe(false)
  expect(resolveGate(id, true, false, 'ios')).toBe(true)
  expect(await pending).toBe(true)
})
