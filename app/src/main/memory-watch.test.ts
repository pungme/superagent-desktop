import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, webContents: {} }))
vi.mock('./agent', () => ({ listSessions: () => [] }))

import { memoryVerdict, SNAPSHOT_AT } from './memory-watch'

const MB = 1024 * 1024
const quiet = { loggedAt: 1_000_000, loggedHeap: 50 * MB, snapshotTaken: false }

describe('memoryVerdict', () => {
  it('says nothing while the heap is steady and a line was just written', () => {
    expect(memoryVerdict({ at: 1_060_000, heapUsed: 60 * MB }, quiet)).toEqual({
      log: false,
      snapshot: false
    })
  })

  it('writes a line every five minutes regardless', () => {
    expect(memoryVerdict({ at: 1_300_000, heapUsed: 50 * MB }, quiet).log).toBe(true)
  })

  it('writes a line at once when the heap jumps, up or down', () => {
    expect(memoryVerdict({ at: 1_060_000, heapUsed: 200 * MB }, quiet).log).toBe(true)
    expect(
      memoryVerdict({ at: 1_060_000, heapUsed: 50 * MB }, { ...quiet, loggedHeap: 400 * MB }).log
    ).toBe(true)
  })

  it('takes one snapshot when the heap runs away, and no second one', () => {
    const big = { at: 1_060_000, heapUsed: SNAPSHOT_AT + MB }
    expect(memoryVerdict(big, quiet)).toEqual({ log: true, snapshot: true })
    expect(memoryVerdict(big, { ...quiet, snapshotTaken: true }).snapshot).toBe(false)
  })
})

describe('old heap snapshots', () => {
  it('are removed after a week, and nothing else in the folder is', async () => {
    const { staleSnapshots, SNAPSHOT_KEEP_MS } = await import('./memory-watch')
    const now = 1_000_000_000_000
    expect(
      staleSnapshots(
        [
          { name: 'main-old.heapsnapshot', mtimeMs: now - SNAPSHOT_KEEP_MS - 1 },
          { name: 'main-new.heapsnapshot', mtimeMs: now - 3600_000 },
          { name: 'notes.txt', mtimeMs: 0 }
        ],
        now
      )
    ).toEqual(['main-old.heapsnapshot'])
  })
})
