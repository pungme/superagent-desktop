import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * `updatedAt` is read as "when something was last said here": the sidebar sorts
 * by it, Activity orders by it, and the unread dot compares it against when you
 * last had the conversation open.
 *
 * The save handler bumped it every time it ran — and the window saves the
 * transcript back on mount, after a reload, and while a chat is kept alive in
 * the background. So a conversation nobody had touched in three weeks would
 * jump to the top of the list wearing an unread dot. This is the query that
 * stops that, tested on its own because the symptom is invisible until a user
 * notices their own history moving around.
 */
const SAVE = `UPDATE chats
    SET data = @data,
        updatedAt = CASE WHEN data = @data THEN updatedAt ELSE @now END
  WHERE id = @id`

describe('saving a transcript', () => {
  let db: Database.Database
  const at = (id: string): number =>
    (db.prepare('SELECT updatedAt FROM chats WHERE id = ?').get(id) as { updatedAt: number })
      .updatedAt

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, data TEXT, updatedAt INTEGER)')
    db.prepare('INSERT INTO chats VALUES (?, ?, ?)').run('c1', '["old"]', 1000)
  })

  it('leaves the clock alone when the transcript is written back unchanged', () => {
    db.prepare(SAVE).run({ id: 'c1', data: '["old"]', now: 9999 })
    expect(at('c1')).toBe(1000)
  })

  it('moves the clock when something was actually said', () => {
    db.prepare(SAVE).run({ id: 'c1', data: '["old","new"]', now: 9999 })
    expect(at('c1')).toBe(9999)
  })

  it('still writes the data either way', () => {
    db.prepare(SAVE).run({ id: 'c1', data: '["old","new"]', now: 9999 })
    const row = db.prepare('SELECT data FROM chats WHERE id = ?').get('c1') as { data: string }
    expect(row.data).toBe('["old","new"]')
  })
})
