/**
 * Which conversation owns which simulator, kept for good.
 *
 * `simByChat` in simulator.ts says what a conversation's pane is showing; it
 * lives in memory and is emptied when a device shuts down. Ownership must not
 * be: on 2026-10-22 a conversation that had driven a device for two days from
 * its own shell scripts lost it to an app restart, the next conversation to ask
 * was handed the same device, and the first one's test runs went on installing
 * its app over the second one's. An owner here survives restarts and device
 * reboots, and goes only when the conversation is gone, the device is gone, or
 * nobody has used it for a day.
 *
 * A device has at most one owner; a conversation may own several (an iPhone
 * and an iPad). No Electron here, so it is tested directly.
 */

export interface Owner {
  chatId: string
  /** When the owner last used it (ms). */
  at: number
  /** When it became the owner: of two claims, the earlier one wins. */
  since: number
}

/** A day without use frees a device, so stale claims do not pile up simulators. */
export const OWNER_IDLE_MS = 24 * 60 * 60 * 1000

export interface OwnerStore {
  load: () => string | undefined
  save: (json: string) => void
  /** A diary line when a device changes hands (memory.log), so the next mix-up can be traced. */
  log?: (line: string) => void
}

export class SimOwners {
  private byUdid = new Map<string, Owner>()
  private store: OwnerStore | null = null

  /** Read what was saved; drop owners whose conversation no longer exists. */
  attach(store: OwnerStore, chatExists: (chatId: string) => boolean, now = Date.now()): void {
    this.store = store
    try {
      const raw = JSON.parse(store.load() || '{}') as Record<string, Owner>
      for (const [udid, o] of Object.entries(raw)) {
        if (!o || typeof o.chatId !== 'string' || typeof o.at !== 'number') continue
        if (now - o.at > OWNER_IDLE_MS || !chatExists(o.chatId)) continue
        this.byUdid.set(udid.toUpperCase(), { chatId: o.chatId, at: o.at, since: o.since ?? o.at })
      }
      store.log?.(
        `sim owners loaded: ${[...this.byUdid].map(([u, o]) => `${u.slice(0, 8)}=${o.chatId.slice(0, 8)}`).join(' ') || 'none'}`
      )
    } catch {
      // A broken record is no reason to stop; it is rewritten on the next claim.
    }
    this.persist()
  }

  private persist(): void {
    this.store?.save(JSON.stringify(Object.fromEntries(this.byUdid)))
  }

  private live(udid: string, now: number): Owner | undefined {
    const o = this.byUdid.get(udid.toUpperCase())
    if (o && now - o.at > OWNER_IDLE_MS) {
      this.byUdid.delete(udid.toUpperCase())
      this.persist()
      return undefined
    }
    return o
  }

  /** The conversation that owns this device, or null. */
  ownerOf(udid: string, now = Date.now()): string | null {
    return this.live(udid, now)?.chatId ?? null
  }

  /** When the owner took it, for "who was first". */
  sinceOf(udid: string, now = Date.now()): number | null {
    return this.live(udid, now)?.since ?? null
  }

  /** The device this conversation used most recently, or null. */
  latestOf(chatId: string, now = Date.now()): string | null {
    let best: [string, number] | null = null
    for (const [udid, o] of [...this.byUdid]) {
      if (o.chatId !== chatId || !this.live(udid, now)) continue
      if (!best || o.at > best[1]) best = [udid, o.at]
    }
    return best?.[0] ?? null
  }

  /** Every device someone other than this conversation owns. */
  takenBy(exceptChatId: string | null | undefined, now = Date.now()): Set<string> {
    const out = new Set<string>()
    for (const [udid, o] of [...this.byUdid])
      if (o.chatId !== exceptChatId && this.live(udid, now)) out.add(udid)
    return out
  }

  /**
   * This conversation is using the device. It becomes the owner when the device
   * is free; an owner using it again keeps it fresh. Returns false when another
   * conversation owns it (nothing changes then).
   */
  claim(chatId: string, udid: string, now = Date.now()): boolean {
    const key = udid.toUpperCase()
    const o = this.live(key, now)
    if (o && o.chatId !== chatId) return false
    this.byUdid.set(key, { chatId, at: now, since: o?.since ?? now })
    if (!o) this.store?.log?.(`sim owner ${key} -> chat ${chatId}`)
    this.persist()
    return true
  }

  /** Hand a device over on purpose (the agent asked to share or take it). */
  give(chatId: string, udid: string, now = Date.now()): void {
    this.byUdid.set(udid.toUpperCase(), { chatId, at: now, since: now })
    this.store?.log?.(`sim owner ${udid.toUpperCase()} -> chat ${chatId} (given)`)
    this.persist()
  }

  /** The device no longer exists (deleted), or its conversation was deleted. */
  forgetDevice(udid: string): void {
    if (this.byUdid.delete(udid.toUpperCase())) this.persist()
  }

  forgetChat(chatId: string): void {
    let changed = false
    for (const [udid, o] of [...this.byUdid])
      if (o.chatId === chatId) {
        this.byUdid.delete(udid)
        changed = true
      }
    if (changed) this.persist()
  }

  /** Keep only devices that still exist; called with a fresh device list. */
  keepOnly(existing: Iterable<string>): void {
    const keep = new Set([...existing].map((u) => u.toUpperCase()))
    let changed = false
    for (const udid of [...this.byUdid.keys()])
      if (!keep.has(udid)) {
        this.byUdid.delete(udid)
        changed = true
      }
    if (changed) this.persist()
  }

  entries(): [string, Owner][] {
    return [...this.byUdid]
  }
}
