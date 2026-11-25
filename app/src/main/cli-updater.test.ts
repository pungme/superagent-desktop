import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./store', () => ({ kvGet: () => undefined }))
vi.mock('./claude-cli', () => ({
  agentEnv: () => ({}),
  findClaude: () => '/x/claude',
  findCodex: () => '/x/codex',
  findAgy: () => '/x/agy'
}))

import {
  updateClaudeCli,
  updateOtherCli,
  cliStatus,
  _resetCliUpdaterForTests,
  type OtherCliDeps
} from './cli-updater'
import { parseCliUpdate } from '../shared/cli-update'

describe('parseCliUpdate', () => {
  it('reads an install', () => {
    expect(
      parseCliUpdate(
        'Current version: 2.1.314\nUpdating to 2.1.325...\nSuccessfully updated from 2.1.314 to version 2.1.325'
      )
    ).toEqual({ version: '2.1.325', from: '2.1.314', updated: true })
  })
  it('reads "already newest" and anything else it cannot read', () => {
    expect(parseCliUpdate('Claude Code is up to date (2.1.325)')).toEqual({
      version: '2.1.325',
      from: null,
      updated: false
    })
    expect(parseCliUpdate('')).toEqual({ version: null, from: null, updated: false })
  })
})

describe('updateClaudeCli', () => {
  it('runs claude update and remembers what it installed', async () => {
    const exec = vi.fn(async () => ({
      ok: true,
      out: 'Successfully updated from 2.1.314 to version 2.1.325'
    }))
    const s = await updateClaudeCli(exec, '/x/claude')
    expect(exec).toHaveBeenCalledWith('/x/claude', ['update'])
    expect(s).toMatchObject({
      version: '2.1.325',
      updatedFrom: '2.1.314',
      running: false,
      error: null
    })
    expect(s.checkedAt).toBeGreaterThan(0)
  })
  it('keeps going when the command fails, and says so', async () => {
    const calls: string[][] = []
    const exec = vi.fn(async (_b: string, args: string[]) => {
      calls.push(args)
      return args[0] === '--version'
        ? { ok: true, out: '2.1.325 (Claude Code)' }
        : { ok: false, out: 'network down' }
    })
    const s = await updateClaudeCli(exec, '/x/claude')
    expect(s.error).toMatch(/could not check/)
    expect(s.version).toBe('2.1.325')
    expect(cliStatus().running).toBe(false)
  })
})

/** Stand-ins: a CLI whose version a shell command changes, and what ran. */
function deps(opts: {
  versions: (string | null)[]
  real?: string | null
  shellOk?: boolean
}): OtherCliDeps & { ran: string[] } {
  const ran: string[] = []
  const versions = [...opts.versions]
  return {
    ran,
    exec: async () => {
      const v = versions.length > 1 ? versions.shift() : versions[0]
      return { ok: v !== null, out: v === null ? 'command not found' : String(v) }
    },
    shell: async (command) => {
      ran.push(command)
      return { ok: opts.shellOk !== false, out: '' }
    },
    realPath: () => (opts.real === undefined ? null : opts.real)
  }
}

describe('updateOtherCli: Antigravity', () => {
  beforeEach(_resetCliUpdaterForTests)
  it('runs agy update and says what it moved from', async () => {
    const d = deps({ versions: ['1.5.17', '1.5.20'] })
    const s = await updateOtherCli('antigravity', d, '/x/agy')
    expect(d.ran).toEqual(["'/x/agy' update"])
    expect(s).toMatchObject({
      version: '1.5.20',
      updatedFrom: '1.5.17',
      error: null,
      running: false
    })
  })

  it('already the newest: no change reported', async () => {
    const s = await updateOtherCli('antigravity', deps({ versions: ['1.5.17'] }), '/x/agy')
    expect(s).toMatchObject({ version: '1.5.17', updatedFrom: null, error: null })
  })

  it('says so when the update failed and nothing changed', async () => {
    const s = await updateOtherCli(
      'antigravity',
      deps({ versions: ['1.5.17'], shellOk: false }),
      '/x/agy'
    )
    expect(s.error).toMatch(/could not check/)
    expect(s.version).toBe('1.5.17')
  })

  it('does nothing when it is not installed', async () => {
    const d = deps({ versions: [null] })
    const s = await updateOtherCli('antigravity', d, 'agy')
    expect(d.ran).toEqual([])
    expect(s).toMatchObject({ version: null, error: null })
  })

  it('quotes a path with a space or a quote', async () => {
    const d = deps({ versions: ['1.0.0'] })
    await updateOtherCli('antigravity', d, "/Users/o'neil/My Tools/agy")
    expect(d.ran[0]).toBe("'/Users/o'\\''neil/My Tools/agy' update")
  })
})

describe('updateOtherCli: Codex', () => {
  beforeEach(_resetCliUpdaterForTests)
  it('updates an npm install with npm', async () => {
    const d = deps({
      versions: ['codex-cli 0.46.0', 'codex-cli 0.47.1'],
      real: '/Users/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js'
    })
    const s = await updateOtherCli('codex', d, '/x/codex')
    expect(d.ran).toEqual(['npm install -g @openai/codex@latest'])
    expect(s).toMatchObject({ version: '0.47.1', updatedFrom: '0.46.0', skipped: null })
  })

  it('updates a Homebrew install with brew', async () => {
    const d = deps({
      versions: ['0.46.0', '0.46.0'],
      real: '/opt/homebrew/Cellar/codex/0.46.0/bin/codex'
    })
    await updateOtherCli('codex', d, '/x/codex')
    expect(d.ran).toEqual(['brew upgrade codex'])
  })

  it('leaves an install it does not know alone, and says why', async () => {
    const d = deps({ versions: ['0.46.0'], real: '/usr/local/bin/codex' })
    const s = await updateOtherCli('codex', d, '/x/codex')
    expect(d.ran).toEqual([])
    expect(s.skipped).toMatch(/does not update/)
    expect(s.version).toBe('0.46.0')
  })

  it('leaves it alone when the binary cannot be found on disk', async () => {
    const d = deps({ versions: ['0.46.0'], real: null })
    await updateOtherCli('codex', d, '/x/codex')
    expect(d.ran).toEqual([])
  })
})
