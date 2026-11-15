import { describe, it, expect, vi } from 'vitest'

vi.mock('./store', () => ({ kvGet: () => undefined }))
vi.mock('./claude-cli', () => ({ agentEnv: () => ({}), findClaude: () => '/x/claude' }))

import { updateClaudeCli, cliStatus } from './cli-updater'
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
