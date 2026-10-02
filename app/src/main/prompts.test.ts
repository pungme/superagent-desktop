import { describe, it, expect, vi } from 'vitest'

vi.mock('./store', () => ({ DESKTOP_WORKSPACE_ID: '__desktop__' }))

vi.mock('./mail', () => ({ mailConnected: vi.fn(() => false) }))

import { buildAppendedPrompt } from './prompts'

describe('the browser briefing', () => {
  it("tells a project's agent which browser it's on and that it can use the user's own", () => {
    const p = buildAppendedPrompt({ provider: 'claude', workspaceId: 'w1', browser: 'Superagent' })
    expect(p).toContain("drove Superagent's built-in browser pane")
    expect(p).toContain("browser_use('yours')")
    expect(p).toContain("Never tell the user you can't use their browser")
  })

  it("names the user's browser when the project is already on it", () => {
    const p = buildAppendedPrompt({ provider: 'codex', workspaceId: 'w1', browser: 'Brave' })
    expect(p).toContain("drove the user's own Brave")
  })

  it('leaves it out of the Computer chat, which always uses the built-in browser', () => {
    const p = buildAppendedPrompt({
      provider: 'claude',
      workspaceId: '__desktop__',
      browser: 'Superagent'
    })
    expect(p).not.toContain('browser_use')
  })

  it('tells a code project not to leave worktrees behind, and no one else', () => {
    const project = buildAppendedPrompt({ provider: 'claude', workspaceId: 'ws1' })
    expect(project).toContain('do not create worktrees')
    expect(buildAppendedPrompt({ provider: 'claude', browserProject: true })).not.toContain(
      'do not create worktrees'
    )
  })

  it('tells a chat in a copy of a folder of repos what it is standing in', () => {
    const p = buildAppendedPrompt({
      provider: 'claude',
      workspaceId: 'ws1',
      repoSet: { root: '/p/shop', repos: ['api'], linked: ['web', 'docs'] }
    })
    expect(p).toContain('own copy of the project folder /p/shop')
    // Which repos are its own already, and which are still the shared ones.
    expect(p).toContain('its own git worktree of `api`')
    expect(p).toContain('The other repositories (`web`, `docs`) are links')
    // A shell command gives no warning; search passes over links.
    expect(p).toContain('call work_on_repo')
    expect(p).toContain('rg --follow')
    // The one thing the copy exists to prevent.
    expect(p).toContain('do not edit, commit in or switch branches in the')
    // A copy that has changed nothing yet has no worktree to speak of.
    const fresh = buildAppendedPrompt({
      provider: 'claude',
      workspaceId: 'ws1',
      repoSet: { root: '/p/shop', repos: [], linked: ['api', 'web'] }
    })
    expect(fresh).toContain('Its repositories (`api`, `web`) are links')
    expect(fresh).not.toContain('already has its own git worktree')
    // And nobody else hears about it.
    expect(buildAppendedPrompt({ provider: 'claude', workspaceId: 'ws1' })).not.toContain(
      'own copy of the project folder'
    )
  })
})

import { mailConnected } from './mail'
describe('Mail briefing', () => {
  it('informs every provider of the connection without including mailbox contents', () => {
    vi.mocked(mailConnected).mockReturnValue(true)
    for (const provider of ['claude', 'codex', 'antigravity'] as const) {
      const prompt = buildAppendedPrompt({ provider })
      expect(prompt).toContain('Apple Mail is connected')
      expect(prompt).toContain('mail_draft')
      expect(prompt).toContain('untrusted data')
    }
    vi.mocked(mailConnected).mockReturnValue(false)
    expect(buildAppendedPrompt({ provider: 'codex' })).toContain('Apple Mail is not connected')
  })
})
