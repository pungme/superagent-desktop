import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginShellExec, loginShellExecAsync } from './claude-cli'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function loginEnvironment(): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-shell-'))
  dirs.push(dir)
  const shell = join(dir, 'login-shell')
  writeFileSync(
    shell,
    '#!/bin/sh\nexport PATH="/version-manager/node/bin:$PATH"\nexec /bin/sh -c "$2"\n',
    { mode: 0o755 }
  )
  vi.stubEnv('SHELL', shell)
  vi.stubEnv('PATH', '/usr/bin:/bin')
}

describe('login shell command execution', () => {
  it('expands PATH after shell startup, synchronously and asynchronously', async () => {
    loginEnvironment()
    const command = 'printf %s "$PATH"'
    expect(loginShellExec(command)).toBe('/version-manager/node/bin:/usr/bin:/bin')
    expect(await loginShellExecAsync(command)).toBe('/version-manager/node/bin:/usr/bin:/bin')
  })
  it('preserves literal dollars and command substitutions', async () => {
    loginEnvironment()
    const command = "printf %s '$PATH $(printf wrong)'"
    expect(loginShellExec(command)).toBe('$PATH $(printf wrong)')
    expect(await loginShellExecAsync(command)).toBe('$PATH $(printf wrong)')
  })
  it('includes stderr only when requested', async () => {
    loginEnvironment()
    const command = 'printf signed-in >&2'
    expect(loginShellExec(command)).toBe('')
    expect(loginShellExec(command, 8000, true)).toBe('signed-in')
    expect(await loginShellExecAsync(command)).toBe('')
    expect(await loginShellExecAsync(command, 8000, true)).toBe('signed-in')
  })
})
