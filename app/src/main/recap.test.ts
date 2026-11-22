import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The recap that re-seeds a session which has lost its memory.
 *
 * It used to live in the window, so a message sent from the phone — companion
 * RPC → main → agent, never through the window — reached an agent that had no
 * memory and no catch-up either. These are the rules, now that main owns them.
 */
const store = vi.hoisted(() => ({
  items: new Map<string, unknown[]>(),
  provider: 'claude' as 'claude' | 'codex'
}))

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  app: { getPath: () => '/tmp/superagent-recap-test', getVersion: () => '0.0.0' }
}))
vi.mock('./hooks', () => ({ getHookUrl: () => '' }))
vi.mock('./mcp', () => ({ getMcpUrl: () => '', writeWorkspaceMcpConfig: () => undefined }))
vi.mock('./store', () => ({
  DESKTOP_WORKSPACE_ID: '__desktop_chat__',
  loadChatItems: (chatId: string) => store.items.get(chatId) ?? [],
  // The recap names the speaker after the chat's own agent.
  getChatProvider: () => store.provider,
  setChatSession: () => undefined
}))

const { markContextLost, takeRecap, buildRecap } = await import('./agent')

const msg = (role: 'user' | 'assistant', text: string, system = false): unknown => ({
  kind: 'msg',
  msg: { id: `${role}-${text.slice(0, 8)}`, role, text, system }
})

describe('recap', () => {
  beforeEach(() => {
    store.provider = 'claude'
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
    expect(recap).toContain('Assistant: Deployed, and the smoke test passed.')
    // It is a prefix: the message itself follows it.
    expect(recap.endsWith('---\n\n')).toBe(true)
  })

  it('does not tell the agent it switched to that it said the earlier replies', () => {
    // A switch sets the new provider before the recap is built.
    store.provider = 'codex'
    expect(buildRecap('c1')).not.toContain('Codex:')
    expect(buildRecap('c1')).toContain('Assistant: Deployed')
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

  it("leaves out the app's own notices, which are not what anyone said", () => {
    store.items.set('c2', [
      msg('assistant', 'This conversation could not be resumed; the agent started fresh.', true),
      msg('user', 'carry on')
    ])
    markContextLost('c2')
    const recap = takeRecap('c2')
    expect(recap).toContain('User: carry on')
    expect(recap).not.toContain('could not be resumed')
  })

  /** The first request and the latest exchange, within a budget: enough for
   *  "continue" to mean something without spending the context on the recap. */
  it('keeps the first request and the latest messages, and says what it left out', () => {
    const many = [
      msg('user', 'Build the pricing page'),
      ...Array.from({ length: 60 }, (_, i) =>
        msg(i % 2 ? 'assistant' : 'user', `message ${i} ` + 'x'.repeat(500))
      )
    ]
    store.items.set('long', many)
    const recap = buildRecap('long')
    const lines = recap.split('\n')
    expect(lines[0]).toBe('User: Build the pricing page')
    expect(lines[1]).toMatch(/^\[… \d+ earlier messages left out …\]$/)
    expect(recap).toContain('message 59')
    expect(recap).not.toContain('message 1 ')
    expect(recap.length).toBeLessThan(13_000)
  })

  it('collapses the whitespace, so a long reply is one line of recap', () => {
    store.items.set('c3', [msg('assistant', 'one\n\n  two\t\tthree')])
    markContextLost('c3')
    expect(buildRecap('c3')).toBe('Assistant: one two three')
  })
})

describe('recap speaker', () => {
  // The log does not say which agent wrote each reply, and the chat's provider is
  // already the new one when the recap is built: a name would be a claim about who
  // the new agent is. So the speaker is neutral, whichever agent reads it.
  it("names no agent, so a recap isn't a claim about who you are", () => {
    store.items.set('c-codex', [
      msg('user', 'What is in this repo?'),
      msg('assistant', 'A desktop app.')
    ])
    for (const p of ['codex', 'claude'] as const) {
      store.provider = p
      expect(buildRecap('c-codex')).toContain('Assistant: A desktop app.')
    }
  })
})

describe('what the agent did, in the recap', () => {
  it('folds the steps between messages into one line', () => {
    store.items.set('steps', [
      { kind: 'msg', msg: { id: 'u', role: 'user', text: 'Fix the header' } },
      { kind: 'tool', tool: { id: 't1', name: 'Read', detail: 'header.css' } },
      { kind: 'tool', tool: { id: 't2', name: 'Bash', detail: 'npm test' } },
      { kind: 'diff', diff: { id: 'd', file: 'header.css', hunks: [] } },
      { kind: 'msg', msg: { id: 'a', role: 'assistant', text: 'Tests fail on Safari.' } }
    ])
    expect(buildRecap('steps')).toBe(
      'User: Fix the header\nSteps: read header.css, ran `npm test`, edited header.css\nAssistant: Tests fail on Safari.'
    )
  })
})
