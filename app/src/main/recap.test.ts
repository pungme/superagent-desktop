import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The recap that re-seeds a session which has lost its memory.
 *
 * It used to live in the window, so a message sent from the phone — companion
 * RPC → main → agent, never through the window — reached an agent that had no
 * memory and no catch-up either. These are the rules, now that main owns them.
 */
const store = vi.hoisted(() => ({ items: new Map<string, unknown[]>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  app: { getPath: () => '/tmp/superagent-recap-test', getVersion: () => '0.0.0' }
}))
vi.mock('./hooks', () => ({ getHookUrl: () => '' }))
vi.mock('./mcp', () => ({ getMcpUrl: () => '', writeWorkspaceMcpConfig: () => undefined }))
vi.mock('./store', () => ({
  DESKTOP_WORKSPACE_ID: '__desktop_chat__',
  loadChatItems: (chatId: string) => store.items.get(chatId) ?? []
}))

const { markContextLost, takeRecap, buildRecap } = await import('./agent')

const msg = (role: 'user' | 'assistant', text: string, system = false): unknown => ({
  kind: 'msg',
  msg: { id: `${role}-${text.slice(0, 8)}`, role, text, system }
})

describe('recap', () => {
  beforeEach(() => {
    store.items.clear()
    store.items.set('c1', [
      msg('user', 'Deploy the staging branch'),
      msg('assistant', 'Deployed, and the smoke test passed.')
    ])
  })

  it('is empty for a chat whose agent remembers', () => {
    expect(takeRecap('c1')).toBe('')
  })

  it('hands over the conversation when the session was lost', () => {
    markContextLost('c1')
    const recap = takeRecap('c1')
    expect(recap).toContain('you have no memory of it')
    expect(recap).toContain('User: Deploy the staging branch')
    expect(recap).toContain('Claude: Deployed, and the smoke test passed.')
    // It is a prefix: the message itself follows it.
    expect(recap.endsWith('---\n\n')).toBe(true)
  })

  /** Once, or every turn would re-send the whole conversation. */
  it('is spent on the first message after the loss', () => {
    markContextLost('c1')
    expect(takeRecap('c1')).not.toBe('')
    expect(takeRecap('c1')).toBe('')
  })

  it('says nothing about a conversation that has not started', () => {
    store.items.set('empty', [])
    markContextLost('empty')
    expect(takeRecap('empty')).toBe('')
  })

  it('leaves out the app\'s own notices, which are not what anyone said', () => {
    store.items.set('c2', [
      msg('assistant', 'This conversation could not be resumed; the agent started fresh.', true),
      msg('user', 'carry on')
    ])
    markContextLost('c2')
    const recap = takeRecap('c2')
    expect(recap).toContain('User: carry on')
    expect(recap).not.toContain('could not be resumed')
  })

  /** Recent turns only, each clipped: enough for "continue" to mean something
   *  without spending the context window on the recap itself. */
  it('keeps the last two dozen turns, clipped', () => {
    const many = Array.from({ length: 40 }, (_, i) => msg('user', `message ${i}`))
    many.push(msg('assistant', 'x'.repeat(2000)))
    store.items.set('long', many)
    markContextLost('long')
    const recap = buildRecap('long')
    expect(recap.split('\n')).toHaveLength(24)
    expect(recap).not.toContain('message 10')
    expect(recap).toContain('message 39')
    expect(recap.split('\n').every((l) => l.length <= 708)).toBe(true)
  })

  it('collapses the whitespace, so a long reply is one line of recap', () => {
    store.items.set('c3', [msg('assistant', 'one\n\n  two\t\tthree')])
    markContextLost('c3')
    expect(buildRecap('c3')).toBe('Claude: one two three')
  })
})
