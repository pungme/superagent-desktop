import { app, ipcMain, webContents, dialog } from 'electron'
import { healthLog } from './health'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { TRANSCRIPT_SCHEMA } from './transcript-db'
import type { TranscriptPatch, TranscriptSnapshot, TranscriptAck } from '../shared/transcript'
let worker: Worker | undefined
let reader: Database.Database | undefined
let seq = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
export function initTranscripts(root: string): void {
  const path = join(root, 'transcripts.sqlite')
  // Only small, empty schema creation is synchronous; migration and writes use the worker.
  const setup = new Database(path)
  setup.exec(TRANSCRIPT_SCHEMA)
  setup.close()
  reader = new Database(path, { readonly: true })
  worker = new Worker(join(__dirname, 'transcript-worker.js'), {
    workerData: { path, legacyPath: join(root, 'cove.db') }
  })
  worker.on('message', ({ seq, result, error }) => {
    const call = pending.get(seq)
    pending.delete(seq)
    if (error) call?.reject(new Error(error))
    else call?.resolve(result)
  })
  const fail = (error: Error): void => {
    for (const p of pending.values()) p.reject(error)
    pending.clear()
    worker = undefined
  }
  worker.on('error', fail)
  worker.on('exit', () =>
    fail(new Error('Transcript worker stopped. Restart Superagent to resume saving.'))
  )
  worker.unref()
  const renderers = new Set<number>()
  const flushes = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  ipcMain.on('transcripts:ready', (event) => {
    renderers.add(event.sender.id)
    event.sender.once('destroyed', () => renderers.delete(event.sender.id))
  })
  ipcMain.on('transcripts:flushed', (event, error?: string) => {
    const wait = flushes.get(event.sender.id)
    flushes.delete(event.sender.id)
    if (error) wait?.reject(new Error(error))
    else wait?.resolve()
  })
  let flushing = false
  /**
   * Every window saves what it has; the ones that cannot are named, not waited
   * for forever. A crashed web view is skipped (it will never answer), a window
   * that does not answer in time is reported, and the caller decides.
   */
  flushAll = (timeoutMs: number): Promise<string[]> =>
    Promise.all(
      [...renderers].map(
        (id) =>
          new Promise<string | null>((resolve) => {
            const contents = webContents.fromId(id)
            if (!contents || contents.isDestroyed() || contents.isCrashed()) return resolve(null)
            const name = (): string =>
              contents.getTitle() || contents.getURL().replace(/^.*\//, '') || `window ${id}`
            const timer = setTimeout(() => {
              flushes.delete(id)
              resolve(`${name()} did not answer in ${Math.round(timeoutMs / 1000)}s`)
            }, timeoutMs)
            flushes.set(id, {
              resolve: () => {
                clearTimeout(timer)
                resolve(null)
              },
              reject: (error) => {
                clearTimeout(timer)
                resolve(`${name()}: ${error.message}`)
              }
            })
            contents.send('transcripts:flush')
          })
      )
    ).then((results) => results.filter((r): r is string => r !== null))
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    if (flushing) return
    flushing = true
    void flushAll(15000)
      .then((stragglers) =>
        transcriptRequest('barrier').then(
          () => stragglers,
          () => stragglers
        )
      )
      .then((stragglers) => {
        if (!stragglers.length) {
          quitting = true
          app.quit()
          return
        }
        healthLog(`quit: did not finish saving: ${stragglers.join(' | ')}`)
        // Not a dead end: say which window, say what is at stake (a second of
        // typing at most — autosave runs every second), and let the user go.
        const choice =
          process.env.COVE_E2E_QUIT_ANYWAY === '1'
            ? 0
            : dialog.showMessageBoxSync({
                type: 'warning',
                buttons: ['Quit anyway', 'Keep open'],
                defaultId: 0,
                cancelId: 1,
                message: 'A window did not finish saving',
                detail: `${stragglers.join('\n')}\n\nConversations save as they go, so quitting now loses at most the last moment of that window. Keep open to try again.`
              })
        if (choice === 0) {
          quitting = true
          app.quit()
        } else flushing = false
      })
  })
}
let quitting = false
let flushAll: (timeoutMs: number) => Promise<string[]> = () => Promise.resolve([])
/** The guard above stands aside: the caller has flushed, or must go regardless. */
export function allowQuit(): void {
  quitting = true
}
/** Save every window's conversation now; the names of those that could not. */
export function flushAllTranscripts(timeoutMs = 8000): Promise<string[]> {
  return flushAll(timeoutMs)
}
export function transcriptRequest<T = void>(op: string, id = '', value?: unknown): Promise<T> {
  if (!worker) return Promise.reject(new Error('Transcript storage is unavailable'))
  return new Promise((resolve, reject) => {
    const key = ++seq
    pending.set(key, { resolve, reject })
    worker!.postMessage({ seq: key, op, id, value })
  })
}
export const loadTranscript = (id: string): Promise<TranscriptSnapshot> =>
  transcriptRequest('load', id)
export const saveTranscriptPatch = (id: string, patch: TranscriptPatch): Promise<TranscriptAck> =>
  transcriptRequest('save', id, patch)
/** Compatibility for infrequent synchronous consumers (recap/phone projection). Autosave and
 * renderer hydration never use this. Undefined means the untouched legacy copy is authoritative. */
export function readTranscript(id: string): string | undefined {
  if (!reader) return undefined
  return reader.transaction(() => {
    if (!reader!.prepare('SELECT 1 FROM transcripts WHERE id=?').get(id)) return undefined
    const rows = reader
      .prepare('SELECT data FROM transcript_items WHERE chatId=? ORDER BY position')
      .all(id) as { data: string }[]
    return '[' + rows.map((r) => r.data).join(',') + ']'
  })()
}

export function resetTranscripts(): Promise<void> {
  return worker ? transcriptRequest('reset') : Promise.resolve()
}
