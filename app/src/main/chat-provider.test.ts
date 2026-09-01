import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Moving one conversation to the other agent must not move any other.
 *
 * The provider used to be worked out lazily from the app's current default, and
 * switching a chat writes that default — so one switch silently moved every
 * conversation that had never run, including ones made weeks earlier. Stamping
 * at creation is what keeps them independent.
 */
describe('a conversation keeps its own agent', () => {
  let db: Database.Database
  const providerOf = (id: string): string | null =>
    (db.prepare('SELECT provider FROM chats WHERE id = ?').get(id) as { provider: string | null })
      .provider

  const create = (id: string, current: string): void => {
    db.prepare('INSERT INTO chats (id, provider, claudeSessionId) VALUES (?, ?, NULL)').run(
      id,
      current
    )
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, provider TEXT, claudeSessionId TEXT)')
  })

  it('records the agent it was made with', () => {
    create('old', 'claude')
    expect(providerOf('old')).toBe('claude')
  })

  it('leaves other conversations alone when one is switched', () => {
    create('a', 'claude')
    create('b', 'claude')
    // Switching b — the same write the app makes — and the default moving with it.
    db.prepare('UPDATE chats SET provider = ?, claudeSessionId = NULL WHERE id = ?').run('codex', 'b')
    expect(providerOf('b')).toBe('codex')
    expect(providerOf('a')).toBe('claude')
  })

  it('gives a conversation made afterwards the new default', () => {
    create('a', 'claude')
    create('c', 'codex')
    expect(providerOf('a')).toBe('claude')
    expect(providerOf('c')).toBe('codex')
  })
})
