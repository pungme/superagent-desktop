import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { TranscriptPatch, TranscriptSnapshot, TranscriptAck } from '../shared/transcript'

export const TRANSCRIPT_SCHEMA = `
 CREATE TABLE IF NOT EXISTS transcripts (
   id TEXT PRIMARY KEY, revision INTEGER NOT NULL, length INTEGER NOT NULL,
   operation TEXT, updatedAt INTEGER NOT NULL DEFAULT 0
 );
 CREATE TABLE IF NOT EXISTS transcript_items (
   chatId TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
   PRIMARY KEY(chatId, position)
 ) WITHOUT ROWID;
`

/** Runs exclusively in the persistence worker. The metadata DB is read-only: a large
 * migration/checkpoint can never hold a write lock needed by Electron's main process. */
export class TranscriptDatabase {
  readonly db: Database.Database
  private legacy: Database.Database
  constructor(path: string, legacyPath: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.exec(TRANSCRIPT_SCHEMA)
    // Upgrade pre-beta.60 metadata layout once, off the main thread and before app startup.
    // The transaction retains the original blob in chat_data; never delete the only copy.
    const upgrade = new Database(legacyPath)
    upgrade.exec('CREATE TABLE IF NOT EXISTS chat_data(id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    upgrade.transaction(() => {
      upgrade.exec("INSERT OR IGNORE INTO chat_data SELECT id,data FROM chats WHERE data NOT IN ('', '[]')")
      upgrade.exec("UPDATE chats SET data='' WHERE data NOT IN ('', '[]') AND EXISTS (SELECT 1 FROM chat_data d WHERE d.id=chats.id AND d.data=chats.data)")
    })()
    upgrade.close()
    this.legacy = new Database(legacyPath, { readonly: true })
  }
  private state(id: string): { revision: number; length: number; operation: string | null } | undefined {
    return this.db.prepare('SELECT revision, length, operation FROM transcripts WHERE id=?').get(id) as ReturnType<TranscriptDatabase['state']>
  }
  private exists(id: string): boolean {
    return !!this.legacy.prepare('SELECT 1 FROM chats WHERE id=?').get(id)
  }
  private ensure(id: string): boolean {
    if (!this.exists(id)) return false
    if (this.state(id)) return true
    const hasTable = this.legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_data'").get()
    const own = hasTable ? this.legacy.prepare('SELECT data FROM chat_data WHERE id=?').get(id) as {data: string} | undefined : undefined
    const old = own ?? this.legacy.prepare('SELECT data FROM chats WHERE id=?').get(id) as {data: string}
    // Never replace an unreadable legacy history with an empty conversation.
    const items: unknown = JSON.parse(old.data || '[]')
    if (!Array.isArray(items)) throw new Error('Saved transcript is not an array; original retained.')
    this.db.transaction(() => {
      const put = this.db.prepare('INSERT INTO transcript_items VALUES (?, ?, ?)')
      items.forEach((item, i) => put.run(id, i, JSON.stringify(item)))
      this.db.prepare('INSERT INTO transcripts(id, revision, length) VALUES (?, 0, ?)').run(id, items.length)
    })()
    return true
  }
  load(id: string): TranscriptSnapshot {
    if (!this.ensure(id)) return { json: null, revision: 0 }
    const rows = this.db.prepare('SELECT data FROM transcript_items WHERE chatId=? ORDER BY position').all(id) as {data: string}[]
    return { json: '[' + rows.map(r => r.data).join(',') + ']', revision: this.state(id)!.revision }
  }
  save(id: string, patch: TranscriptPatch): TranscriptAck {
    if (!this.ensure(id)) throw new Error('Conversation no longer exists')
    return this.db.transaction(() => {
      const state = this.state(id)!
      if (state.operation === patch.operation) return { revision: state.revision }
      if (state.revision !== patch.revision) throw new Error('Transcript changed in another window. Reopen this conversation before saving again.')
      if (!Number.isSafeInteger(patch.length) || patch.length < 0) throw new Error('Invalid transcript length')
      const indices = new Set<number>()
      for (const [index, json] of patch.changes) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= patch.length || indices.has(index)) throw new Error('Invalid transcript position')
        indices.add(index)
        JSON.parse(json)
      }
      for (let i = state.length; i < patch.length; i++) if (!indices.has(i)) throw new Error('Incomplete transcript patch')
      const put = this.db.prepare('INSERT INTO transcript_items VALUES (?, ?, ?) ON CONFLICT(chatId,position) DO UPDATE SET data=excluded.data WHERE data<>excluded.data')
      let changed = patch.length !== state.length
      for (const [i, json] of patch.changes) if (put.run(id, i, json).changes) changed = true
      this.db.prepare('DELETE FROM transcript_items WHERE chatId=? AND position>=?').run(id, patch.length)
      const revision = state.revision + 1
      this.db.prepare('UPDATE transcripts SET revision=?, length=?, operation=?, updatedAt=CASE WHEN ? THEN ? ELSE updatedAt END WHERE id=?').run(revision, patch.length, patch.operation, changed ? 1 : 0, Date.now(), id)
      return { revision }
    })()
  }
  replace(id: string, json: string): void {
    if (!this.ensure(id)) return
    const items: unknown = JSON.parse(json)
    if (!Array.isArray(items)) throw new Error('Invalid transcript')
    this.save(id, { revision: this.state(id)!.revision, operation: randomUUID(), length: items.length, changes: items.map((item, i) => [i, JSON.stringify(item)]) })
  }
  append(id: string, items: unknown[]): void {
    if (!items.length || !this.ensure(id)) return
    const state = this.state(id)!
    this.save(id, { revision: state.revision, operation: randomUUID(), length: state.length + items.length, changes: items.map((item, i) => [state.length + i, JSON.stringify(item)]) })
  }
  clear(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM transcript_items WHERE chatId=?').run(id)
      this.db.prepare('INSERT INTO transcripts(id, revision, length) VALUES (?, 1, 0) ON CONFLICT(id) DO UPDATE SET revision=revision+1, length=0, operation=NULL').run(id)
    })()
  }
  reset(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM transcript_items; UPDATE transcripts SET length=0, revision=revision+1, operation=NULL')
    })()
  }
  close(): void { this.db.close(); this.legacy.close() }
}
