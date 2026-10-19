import { transcriptChanges, type TranscriptPatch, type TranscriptAck } from './transcript'

/** One outstanding save per chat. Keep a failed packet for idempotent retry: an IPC response
 * can be lost after a successful disk commit. Never advance the baseline before acknowledgement. */
export class TranscriptWriter<T> {
  private baseline: readonly T[]
  private revision: number
  private pending?: { patch: TranscriptPatch; items: readonly T[] }
  private running?: Promise<void>
  constructor(items: readonly T[], revision: number, private encode: (item: T) => string,
    private send: (patch: TranscriptPatch) => Promise<TranscriptAck>) {
    this.baseline = items
    this.revision = revision
  }
  save(items: () => readonly T[]): Promise<void> {
    if (this.running) return this.running
    this.running = this.flush(items).finally(() => { this.running = undefined })
    return this.running
  }
  private async flush(current: () => readonly T[]): Promise<void> {
    do {
      if (!this.pending) {
        const items = current()
        const changes = transcriptChanges(this.baseline, items, this.encode)
        if (!changes.length && items.length === this.baseline.length) return
        this.pending = { items, patch: { revision: this.revision, operation: crypto.randomUUID(), length: items.length, changes } }
      }
      const ack = await this.send(this.pending.patch)
      this.revision = ack.revision
      this.baseline = this.pending.items
      this.pending = undefined
    } while (current() !== this.baseline)
  }
}
