import { parentPort, workerData } from 'node:worker_threads'
import { TranscriptDatabase } from './transcript-db'
const store = new TranscriptDatabase(workerData.path, workerData.legacyPath)
parentPort!.on('message', ({ seq, op, id, value }) => {
  try {
    const result = op === 'load' ? store.load(id) : op === 'save' ? store.save(id, value)
      : op === 'replace' ? store.replace(id, value) : op === 'append' ? store.append(id, value) : op === 'reset' ? store.reset() : op === 'clear' ? store.clear(id) : undefined
    parentPort!.postMessage({ seq, result })
  } catch (error) { parentPort!.postMessage({ seq, error: (error as Error).message }) }
})
