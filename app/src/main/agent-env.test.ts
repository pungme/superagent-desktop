import { describe, it, expect } from 'vitest'
import { agentEnv } from './claude-cli'

/**
 * Started from the Dock, the app's PATH is /usr/bin:/bin and little else. A
 * CLI installed with npm (`#!/usr/bin/env node`) then died before it said a
 * word, and the chat blamed the sign-in. Its own folder — where nvm keeps
 * node — comes first now.
 */
describe('agentEnv', () => {
  const dock = { HOME: '/Users/x', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

  it('puts the CLI’s own folder first, and keeps what was there', () => {
    const env = agentEnv('/Users/x/.nvm/versions/node/v22/bin/codex', dock)
    const path = env.PATH!.split(':')
    expect(path[0]).toBe('/Users/x/.nvm/versions/node/v22/bin')
    for (const p of dock.PATH.split(':')) expect(path).toContain(p)
    expect(env.HOME).toBe('/Users/x')
  })

  it('names each folder once', () => {
    const path = agentEnv('/usr/bin/codex', dock).PATH!.split(':')
    expect(path.length).toBe(new Set(path).size)
  })

  it('adds no empty entry for a bare name', () => {
    expect(agentEnv('codex', dock).PATH!.split(':')).not.toContain('')
  })
})
