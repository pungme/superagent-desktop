import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findSessionFiles, forgetAgentSession, sessionHomes } from './incognito'

/**
 * An incognito chat takes the agent's own log of its session with it. Against
 * real folders in a temp dir: nothing outside them may go.
 */
const ID = '2b018f43-92ee-45df-bdbd-44964af72390'
const OTHER = '9f3c1a77-0000-4000-8000-000000000001'

describe('forgetting an agent session', () => {
  let root: string
  let homes: ReturnType<typeof sessionHomes>
  const put = (p: string, text = 'x'): void => {
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cove-incognito-'))
    const userData = join(root, 'userData')
    mkdirSync(join(userData, 'claude-accounts', 'claude-aaaa'), { recursive: true })
    homes = sessionHomes(userData, join(root, 'home'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds the home folders: the main one, each extra account, and Codex', () => {
    expect(homes.claude).toEqual([
      join(root, 'home', '.claude'),
      join(root, 'userData', 'claude-accounts', 'claude-aaaa')
    ])
    expect(homes.codex).toEqual([join(root, 'home', '.codex')])
  })

  it("removes Claude's log of that session, in every account, and nothing else", () => {
    const main = join(root, 'home', '.claude', 'projects', '-Users-me-app')
    const acct = join(homes.claude[1], 'projects', '-Users-me-other')
    put(join(main, `${ID}.jsonl`))
    put(join(main, ID, 'subagents', 'a.jsonl')) // the session's own folder
    put(join(acct, `${ID}.jsonl`))
    put(join(main, `${OTHER}.jsonl`), 'keep me')
    expect(findSessionFiles('claude', ID, homes)).toHaveLength(3)
    expect(forgetAgentSession('claude', ID, homes)).toBe(3)
    expect(existsSync(join(main, `${ID}.jsonl`))).toBe(false)
    expect(existsSync(join(main, ID))).toBe(false)
    expect(existsSync(join(acct, `${ID}.jsonl`))).toBe(false)
    expect(existsSync(join(main, `${OTHER}.jsonl`))).toBe(true)
  })

  it("removes Codex's rollout file for that session", () => {
    const day = join(root, 'home', '.codex', 'sessions', '2026', '11', '24')
    put(join(day, `rollout-2026-11-24T10-00-00-${ID}.jsonl`))
    put(join(day, `rollout-2026-11-24T10-00-00-${OTHER}.jsonl`))
    expect(forgetAgentSession('codex', ID, homes)).toBe(1)
    expect(existsSync(join(day, `rollout-2026-11-24T10-00-00-${OTHER}.jsonl`))).toBe(true)
  })

  it('does not touch a Claude folder when the chat ran on Codex, or the reverse', () => {
    const main = join(root, 'home', '.claude', 'projects', 'p')
    put(join(main, `${ID}.jsonl`))
    expect(forgetAgentSession('codex', ID, homes)).toBe(0)
    expect(existsSync(join(main, `${ID}.jsonl`))).toBe(true)
  })

  it('refuses an id that could name a path', () => {
    const outside = join(root, 'home', 'secret.txt')
    put(outside)
    for (const bad of ['../../secret.txt', '..', '', 'a/b', '*', '../.claude']) {
      expect(findSessionFiles('claude', bad, homes)).toEqual([])
      expect(forgetAgentSession('claude', bad, homes)).toBe(0)
    }
    expect(existsSync(outside)).toBe(true)
  })

  it('is quiet when nothing is there', () => {
    expect(forgetAgentSession('claude', ID, homes)).toBe(0)
    expect(forgetAgentSession('antigravity', ID, homes)).toBe(0)
  })
})
