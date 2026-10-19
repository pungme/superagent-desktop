/** A revision is acknowledged only after SQLite commits. Indices preserve every item, including
 * legacy items without ids. Revisions reject stale windows and saves queued before a clear. */
export interface TranscriptPatch {
  revision: number
  operation: string
  length: number
  changes: [number, string][]
}
export interface TranscriptSnapshot { json: string | null; revision: number }
export interface TranscriptAck { revision: number }

/** Immutable React items let us skip serialization of unchanged history, including pictures. */
export function transcriptChanges<T>(before: readonly T[], after: readonly T[], encode: (item: T) => string): [number, string][] {
  const changes: [number, string][] = []
  for (let i = 0; i < after.length; i++) {
    if (before[i] !== after[i]) changes.push([i, encode(after[i])])
  }
  return changes
}
