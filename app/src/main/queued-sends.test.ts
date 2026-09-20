import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * A message a phone held to send once the chat's current turn ends (see
 * `addQueuedSend`/`takeQueuedSends`/`cancelQueuedSend` in store.ts). Tested
 * against the literal schema and queries rather than importing store.ts,
 * which needs Electron at import time — the same convention chat-save.test.ts
 * uses. What matters here is FIFO order and that a take is a claim: two
 * readers must never both get the same row.
 */
describe('queued sends', () => {
  let db: Database.Database
  let seq = 0
  const add = (chatId: string, text: string): string => {
    const id = `q${++seq}`
    db.prepare('INSERT INTO queued_sends (id, chatId, text, createdAt) VALUES (?, ?, ?, ?)').run(
      id,
      chatId,
      text,
      seq // stand-in for Date.now(), strictly increasing
    )
    return id
  }
  const take = (chatId: string): { id: string; text: string }[] => {
    const rows = db
      .prepare('SELECT id, text FROM queued_sends WHERE chatId = ? ORDER BY createdAt ASC')
      .all(chatId) as { id: string; text: string }[]
    if (rows.length) db.prepare('DELETE FROM queued_sends WHERE chatId = ?').run(chatId)
    return rows
  }
  const cancel = (chatId: string, id: string): boolean =>
    db.prepare('DELETE FROM queued_sends WHERE id = ? AND chatId = ?').run(id, chatId).changes > 0

  beforeEach(() => {
    seq = 0
    db = new Database(':memory:')
    db.exec(
      'CREATE TABLE queued_sends (id TEXT PRIMARY KEY, chatId TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL)'
    )
  })

  it('returns nothing for a chat with no queued messages', () => {
    expect(take('c1')).toEqual([])
  })

  it('returns queued messages oldest first', () => {
    add('c1', 'first')
    add('c1', 'second')
    expect(take('c1').map((r) => r.text)).toEqual(['first', 'second'])
  })

  it('is a claim: a second take gets nothing back', () => {
    add('c1', 'only one')
    take('c1')
    expect(take('c1')).toEqual([])
  })

  it('never leaks a message queued for a different chat', () => {
    add('c1', 'for c1')
    add('c2', 'for c2')
    expect(take('c1').map((r) => r.text)).toEqual(['for c1'])
    expect(take('c2').map((r) => r.text)).toEqual(['for c2'])
  })

  it('cancel removes just that message, leaving the rest queued', () => {
    const keep = add('c1', 'keep me')
    const drop = add('c1', 'drop me')
    expect(cancel('c1', drop)).toBe(true)
    expect(take('c1').map((r) => r.id)).toEqual([keep])
  })

  it('cancel is a no-op for a message under a different chat', () => {
    const id = add('c1', 'mine')
    expect(cancel('c2', id)).toBe(false)
    expect(take('c1').map((r) => r.id)).toEqual([id])
  })
})
