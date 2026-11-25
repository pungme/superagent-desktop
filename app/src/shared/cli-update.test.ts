import { describe, it, expect } from 'vitest'
import { CODEX_UPDATE_COMMAND, codexInstallKind, versionOf } from './cli-update'

describe('versions', () => {
  it('reads the version whatever the CLI wraps it in', () => {
    expect(versionOf('codex-cli 0.46.0')).toBe('0.46.0')
    expect(versionOf('1.5.17')).toBe('1.5.17')
    expect(versionOf('2.1.325 (Claude Code)')).toBe('2.1.325')
    expect(versionOf('0.47.0-alpha.3\n')).toBe('0.47.0-alpha.3')
    expect(versionOf('command not found')).toBeNull()
    expect(versionOf('')).toBeNull()
  })
})

describe('how Codex was installed', () => {
  it('is npm when it lives in a node_modules (nvm, Homebrew node, system node)', () => {
    expect(
      codexInstallKind(
        '/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/@openai/codex/bin/codex.js'
      )
    ).toBe('npm')
    expect(codexInstallKind('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toBe(
      'npm'
    )
  })

  it('is Homebrew when it lives in the Cellar or Caskroom', () => {
    expect(codexInstallKind('/opt/homebrew/Cellar/codex/0.46.0/bin/codex')).toBe('brew')
    expect(codexInstallKind('/opt/homebrew/Caskroom/codex/0.46.0/codex')).toBe('brew')
  })

  it('is left alone when it is anywhere else', () => {
    expect(codexInstallKind('/usr/local/bin/codex')).toBe('other')
    expect(codexInstallKind('/Users/me/bin/codex')).toBe('other')
  })

  it('updates each the way it was installed', () => {
    expect(CODEX_UPDATE_COMMAND.npm).toBe('npm install -g @openai/codex@latest')
    expect(CODEX_UPDATE_COMMAND.brew).toBe('brew upgrade codex')
  })
})
