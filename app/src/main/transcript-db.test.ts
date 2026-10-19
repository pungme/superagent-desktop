import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { TranscriptDatabase } from './transcript-db'
import { TranscriptWriter } from '../shared/transcript-writer'
let dir: string, legacy: Database.Database, store: TranscriptDatabase
const initial = [{ kind: 'msg', msg: { id: '1', text: 'original' } }]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-test-'))
  legacy = new Database(join(dir, 'cove.db'))
  legacy.pragma('journal_mode=WAL')
  legacy.exec('CREATE TABLE chats(id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  legacy.prepare('INSERT INTO chats VALUES (?,?)').run('chat', JSON.stringify(initial))
  store = new TranscriptDatabase(join(dir, 'transcripts.sqlite'), join(dir, 'cove.db'))
})
afterEach(() => { store.close(); legacy.close(); rmSync(dir, { recursive: true, force: true }) })
describe('durable incremental transcripts', () => {
  it('retains the original and migrates once, preserving edits, appends and truncation on restart', () => {
    expect(store.load('chat')).toEqual({ json: JSON.stringify(initial), revision: 0 })
    expect(legacy.prepare('SELECT data FROM chat_data WHERE id=?').pluck().get('chat')).toBe(JSON.stringify(initial))
    store.save('chat', { revision: 0, operation: 'a', length: 2, changes: [[0, '{"edited":true}'], [1, '{"new":true}']] })
    store.close()
    store = new TranscriptDatabase(join(dir, 'transcripts.sqlite'), join(dir, 'cove.db'))
    expect(JSON.parse(store.load('chat').json!)).toEqual([{edited:true}, {new:true}])
    store.save('chat', { revision: 1, operation: 'b', length: 1, changes: [] })
    expect(JSON.parse(store.load('chat').json!)).toEqual([{edited:true}])
  })
  it('rejects stale writers and retries a committed operation without duplicating it', () => {
    const patch = { revision: 0, operation: 'retry', length: 2, changes: [[1, '{"new":true}']] as [number,string][] }
    expect(store.save('chat', patch)).toEqual({revision:1})
    expect(store.save('chat', patch)).toEqual({revision:1})
    expect(() => store.save('chat', {...patch, operation:'stale'})).toThrow('another window')
    expect(JSON.parse(store.load('chat').json!)).toHaveLength(2)
    store.clear('chat')
    expect(() => store.save('chat', patch)).toThrow('another window')
    expect(store.load('chat').json).toBe('[]')
  })
  it('rolls back a failed migration and leaves its source untouched', () => {
    store.db.exec("CREATE TRIGGER fail BEFORE INSERT ON transcript_items BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    expect(() => store.load('chat')).toThrow('disk failure')
    expect(store.db.prepare('SELECT COUNT(*) FROM transcripts').pluck().get()).toBe(0)
    expect(legacy.prepare('SELECT data FROM chat_data').pluck().get()).toBe(JSON.stringify(initial))
    store.db.exec('DROP TRIGGER fail')
    expect(store.load('chat').json).toBe(JSON.stringify(initial))
  })
  it('rejects malformed patches atomically and does not invent missing chats', () => {
    expect(() => store.save('missing', {revision:0,operation:'a',length:0,changes:[]})).toThrow('no longer exists')
    expect(() => store.save('chat', {revision:0,operation:'a',length:3,changes:[[1,'{}']]})).toThrow('Incomplete')
    expect(store.load('chat').json).toBe(JSON.stringify(initial))
  })
  it('does not replace corrupt legacy history with empty history', () => {
    legacy.prepare('INSERT INTO chats VALUES (?,?)').run('bad', 'broken-json')
    expect(() => store.load('bad')).toThrow()
    expect(store.db.prepare('SELECT 1 FROM transcripts WHERE id=?').get('bad')).toBeUndefined()
  })
  it('retries a lost acknowledgement without reserializing history or duplicating messages', async () => {
    const snapshot = store.load('chat')
    let items = JSON.parse(snapshot.json!) as unknown[]
    let encoded = 0, fail = true
    const writer = new TranscriptWriter(items, snapshot.revision, item => {encoded++; return JSON.stringify(item)}, async patch => {
      const ack = store.save('chat', patch)
      if (fail) { fail = false; throw new Error('lost reply') }
      return ack
    })
    items = [...items, {new: true}]
    await expect(writer.save(() => items)).rejects.toThrow('lost reply')
    await writer.save(() => items)
    expect(encoded).toBe(1)
    expect(JSON.parse(store.load('chat').json!)).toEqual([...initial, {new:true}])
    await writer.save(() => items)
    expect(encoded).toBe(1)
  })
})
