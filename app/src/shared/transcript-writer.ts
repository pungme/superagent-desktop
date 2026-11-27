import { transcriptChanges, type TranscriptPatch, type TranscriptAck } from './transcript'

/** One outstanding save per chat. Keep a failed packet for idempotent retry: an IPC response
 * can be lost after a successful disk commit. Never advance the baseline before acknowledgement. */
export class TranscriptWriter<T> {
  private baseline: readonly T[]
  private revision: number
  private pending?: { patch: TranscriptPatch; items: readonly T[] }
  private running?: Promise<void>
  constructor(
    items: readonly T[],
    revision: number,
    private encode: (item: T) => string,
    private send: (patch: TranscriptPatch) => Promise<TranscriptAck>
  ) {
    this.baseline = items
    this.revision = revision
  }
  save(items: () => readonly T[]): Promise<void> {
    if (this.running) return this.running
    this.running = this.flush(items).finally(() => {
      this.running = undefined
    })
    return this.running
  }
  private async flush(current: () => readonly T[]): Promise<void> {
    do {
      if (!this.pending) {
        const items = current()
        const changes = transcriptChanges(this.baseline, items, this.encode)
        if (!changes.length && items.length === this.baseline.length) return
        this.pending = {
          items,
          patch: {
            revision: this.revision,
            operation: crypto.randomUUID(),
            length: items.length,
            changes
          }
        }
      }
      let ack: TranscriptAck
      try {
        ack = await this.send(this.pending.patch)
      } catch (error) {
        // A patch the Mac will always refuse (out of date, malformed, or for a conversation
        // that is gone) must not be resent unchanged for ever, with later edits never in it.
        // A lost reply is different: that patch is kept and sent again as it was.
        if (
          /Invalid transcript|Incomplete transcript patch|changed in another window|no longer exists/.test(
            String((error as Error)?.message)
          )
        )
          this.pending = undefined
        throw error
      }
      this.revision = ack.revision
      this.baseline = this.pending.items
      this.pending = undefined
    } while (current() !== this.baseline)
  }
}
