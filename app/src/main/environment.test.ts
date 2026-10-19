import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: {} }))
vi.mock('./agent-signin', () => ({ cancelAgentSignIn: vi.fn(), signInAgent: vi.fn() }))
vi.mock('./claude-cli', () => ({ loginShellExec: vi.fn(), loginShellExecAsync: vi.fn() }))
import { loginShellExecAsync } from './claude-cli'
import { detectEnvironment } from './environment'
const probe = vi.mocked(loginShellExecAsync)
beforeEach(() => {
  probe.mockReset()
  probe.mockImplementation(async (cmd) => {
    if (cmd === 'codex --version') return 'codex 0.160.1'
    if (cmd === 'codex login status') return 'Logged in using ChatGPT'
    throw new Error('command not found')
  })
})
describe('onboarding diagnostics', () => {
  it('distinguishes an authentication check failure from signed out', async () => {
    probe.mockImplementation(async (cmd) => {
      if (cmd === 'codex --version') return 'codex 0.160.1'
      if (cmd === 'codex login status') throw new Error('invalid config.toml')
      throw new Error('command not found')
    })
    const result = await detectEnvironment()
    expect(result.codex).toMatchObject({ installed: true, loggedIn: false, setupBlocked: true })
    expect(result.codex.issue).toContain('invalid config.toml')
  })
  it('offers sign-in when the CLI explicitly reports signed out', async () => {
    probe.mockImplementation(async (cmd) => {
      if (cmd === 'codex --version') return 'codex 0.160.1'
      if (cmd === 'codex login status')
        throw Object.assign(new Error('exit 1'), { stderr: 'Not logged in' })
      throw new Error('command not found')
    })
    expect((await detectEnvironment()).codex).toMatchObject({
      installed: true,
      loggedIn: false,
      setupBlocked: false
    })
  })
  it('identifies missing Node before offering an npm install', async () => {
    probe.mockRejectedValue(new Error('command not found'))
    const result = await detectEnvironment()
    expect(result.codex.setupBlocked).toBe(true)
    expect(result.codex.issue).toContain('Node.js')
  })
  it('rechecks after an external installation', async () => {
    expect((await detectEnvironment()).codex.installed).toBe(true)
    probe.mockImplementation(async (cmd) => {
      if (cmd === 'claude --version') return '2.1.0'
      if (cmd === 'claude auth status') return '{"loggedIn":true}'
      throw new Error('command not found')
    })
    expect((await detectEnvironment()).claude).toMatchObject({ installed: true, loggedIn: true })
  })
})
