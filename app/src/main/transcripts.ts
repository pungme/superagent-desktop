import { app, ipcMain, webContents, dialog } from 'electron'
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
  worker = new Worker(join(__dirname, 'transcript-worker.js'), { workerData: { path, legacyPath: join(root, 'cove.db') } })
  worker.on('message', ({ seq, result, error }) => {
    const call = pending.get(seq)
    pending.delete(seq)
    if (error) call?.reject(new Error(error)); else call?.resolve(result)
  })
  const fail = (error: Error): void => { for (const p of pending.values()) p.reject(error); pending.clear(); worker = undefined }
  worker.on('error', fail)
  worker.on('exit', () => fail(new Error('Transcript worker stopped. Restart Superagent to resume saving.')))
  worker.unref()
  const renderers = new Set<number>()
  const flushes = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  ipcMain.on('transcripts:ready', event => {
    renderers.add(event.sender.id)
    event.sender.once('destroyed', () => renderers.delete(event.sender.id))
  })
  ipcMain.on('transcripts:flushed', (event, error?: string) => {
    const wait = flushes.get(event.sender.id)
    flushes.delete(event.sender.id)
    if (error) wait?.reject(new Error(error)); else wait?.resolve()
  })
  let quitting = false
  let flushing = false
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    if (flushing) return
    flushing = true
    void Promise.all([...renderers].map(id => new Promise<void>((resolve, reject) => {
      const contents = webContents.fromId(id)
      if (!contents || contents.isDestroyed()) return resolve()
      const timer = setTimeout(() => { flushes.delete(id); reject(new Error('A conversation did not finish saving.')) }, 15000)
      flushes.set(id, { resolve: () => { clearTimeout(timer); resolve() }, reject: error => { clearTimeout(timer); reject(error) } })
      contents.send('transcripts:flush')
    }))).then(() => transcriptRequest('barrier')).then(() => {
      quitting = true
      app.quit()
    }).catch(error => {
      flushing = false
      dialog.showErrorBox('Superagent could not finish saving', `${error.message}\nThe app has stayed open so you can retry or copy any unsaved text.`)
    })
  })
}
export function transcriptRequest<T = void>(op: string, id = '', value?: unknown): Promise<T> {
  if (!worker) return Promise.reject(new Error('Transcript storage is unavailable'))
  return new Promise((resolve, reject) => { const key = ++seq; pending.set(key, { resolve, reject }); worker!.postMessage({ seq: key, op, id, value }) })
}
export const loadTranscript = (id: string): Promise<TranscriptSnapshot> => transcriptRequest('load', id)
export const saveTranscriptPatch = (id: string, patch: TranscriptPatch): Promise<TranscriptAck> => transcriptRequest('save', id, patch)
/** Compatibility for infrequent synchronous consumers (recap/phone projection). Autosave and
 * renderer hydration never use this. Undefined means the untouched legacy copy is authoritative. */
export function readTranscript(id: string): string | undefined {
  if (!reader) return undefined
  return reader.transaction(() => {
  if (!reader!.prepare('SELECT 1 FROM transcripts WHERE id=?').get(id)) return undefined
  const rows = reader.prepare('SELECT data FROM transcript_items WHERE chatId=? ORDER BY position').all(id) as {data: string}[]
  return '[' + rows.map(r => r.data).join(',') + ']'
  })()
}

export function resetTranscripts(): Promise<void> { return worker ? transcriptRequest('reset') : Promise.resolve() }
