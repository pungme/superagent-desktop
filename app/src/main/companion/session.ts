import { app } from 'electron'
import { createHash } from 'crypto'
import { Sealer, Opener, aadFor, probe, newToken, DeviceKeys } from './crypto'
import { machineId } from './identity'
import { addDevice, allDeviceKeys, tokenMatches, touchDevice, setPushToken } from './devices'
import { pendingPairing, offerPairing, cancelPairing, prettyHostname } from './pairing'
import { eventsAfter, logDiverged, tailStart } from './log'
import { draftOf, saveDraft } from '../drafts'
import { handleRpc, listTree, listChats } from './rpc'
import { openPanes } from '../browser'
import { wireBrowser } from './index'
import { openSimulators, deviceLabel } from '../simulator'
import type { RelayClient } from './relay-client'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type WireMachine
} from '../../shared/companion-protocol'

/** With this much still unsent on the relay socket, a catch-up waits instead of adding to it. */
const REPLAY_HIGH_WATER = 1024 * 1024
/** Asks for one chat's catch-up are counted over this long... */
const REPLAY_WINDOW_MS = 30_000
/** ...and this many of them are answered at once. */
const REPLAY_FREE = 3

/**
 * How long the next catch-up of one chat waits, given how many this phone has
 * asked for lately (this one included).
 *
 * A phone asks again whenever what it is sent does not line up with what it
 * holds, and each ask used to be answered in full, at once: up to ten thousand
 * events. A phone that kept asking was sent the same conversation over and
 * over, faster than the socket could take it. On 2026-10-09 that was 3.4
 * million queued events, 2.4 GB, and main died at the heap ceiling a few
 * minutes after a phone connected. So the first few are free, and a phone
 * that keeps asking is answered less and less often.
 */
export function replayDelay(recent: number): number {
  return recent <= REPLAY_FREE ? 0 : Math.min(15_000, 500 * 2 ** (recent - REPLAY_FREE))
}

interface Replay {
  after: number
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * One phone connection through the relay. Starts anonymous: the first frame
 * tells us who it is by which key opens it — the pending pairing's, or a paired
 * device's. From then on everything is sealed both ways.
 */
export class ClientConn {
  deviceId: string | null = null
  private keys: DeviceKeys | null = null
  private sealer: Sealer | null = null
  private opener: Opener | null = null
  private pairing = false
  readonly subs = new Set<string>()
  presenceActive = false
  private closed = false
  /** Chats being caught up, one job each: a new ask replaces the one running. */
  private replays = new Map<string, Replay>()
  private replayAsks = new Map<string, number[]>()

  constructor(
    readonly id: string,
    private relay: RelayClient,
    private onAuthed: (conn: ClientConn) => void,
    private onClosed: (conn: ClientConn) => void
  ) {}

  get authenticated(): boolean {
    return this.deviceId !== null && !this.pairing
  }

  send(frame: ServerFrame): void {
    if (this.closed || !this.sealer) return
    // Streaming text is expendable; anything else waits its turn.
    if (frame.t === 'delta' && this.relay.bufferedAmount > 4 * 1024 * 1024) return
    this.relay.send(this.id, this.sealer.seal(JSON.stringify(frame)))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.stopReplays()
    this.relay.closeConn(this.id)
    this.onClosed(this)
  }

  /**
   * Whether this chat is still being caught up. Its live events are held back
   * until it is: the catch-up reads them from the log in order, and one sent
   * ahead of it would read as a gap on the phone and start the catch-up again.
   */
  replaying(chatId: string): boolean {
    return this.replays.has(chatId)
  }

  private stopReplays(): void {
    for (const job of this.replays.values()) if (job.timer) clearTimeout(job.timer)
    this.replays.clear()
  }

  private stopReplay(chatId: string): void {
    const job = this.replays.get(chatId)
    if (job?.timer) clearTimeout(job.timer)
    this.replays.delete(chatId)
  }

  /** Send everything after `after`, a page at a time, as fast as the socket drains. */
  private startReplay(chatId: string, after: number): void {
    this.stopReplay(chatId)
    const now = Date.now()
    const asks = (this.replayAsks.get(chatId) ?? []).filter((t) => now - t < REPLAY_WINDOW_MS)
    asks.push(now)
    this.replayAsks.set(chatId, asks)
    const job: Replay = { after, timer: null }
    this.replays.set(chatId, job)
    const wait = replayDelay(asks.length)
    if (wait === 0) this.pumpReplay(chatId, job)
    else job.timer = setTimeout(() => this.pumpReplay(chatId, job), wait)
  }

  private pumpReplay(chatId: string, job: Replay): void {
    job.timer = null
    if (this.replays.get(chatId) !== job) return
    if (this.closed || !this.subs.has(chatId)) {
      this.replays.delete(chatId)
      return
    }
    if (this.relay.bufferedAmount > REPLAY_HIGH_WATER) {
      job.timer = setTimeout(() => this.pumpReplay(chatId, job), 100)
      return
    }
    const { events, hasMore } = eventsAfter(chatId, job.after)
    for (const event of events) this.send({ t: 'event', event })
    if (events.length && hasMore) {
      job.after = events[events.length - 1].seq
      job.timer = setTimeout(() => this.pumpReplay(chatId, job), 0)
      return
    }
    this.replays.delete(chatId)
    // Always, even when empty: a phone still holding words that were
    // since sent from the Mac has to hear that the composer is clear.
    this.send({ t: 'draft', chatId, text: draftOf(chatId) })
  }

  /** Called by the relay client when the phone went away. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.stopReplays()
    this.onClosed(this)
  }

  async receive(data: string): Promise<void> {
    if (this.closed) return
    if (!this.keys) {
      if (!this.identify(data)) {
        // Nobody's key opens this — not our phone. Drop the connection.
        const pend = pendingPairing()
        const fp = pend ? createHash('sha256').update(pend.secret).digest('hex').slice(0, 8) : '-'
        console.log(
          `[companion] conn ${this.id}: first frame (${data.length} chars) opened by no key; pairing=${!!pend} secretFp=${fp} m=${machineId().slice(0, 8)} frame=${data.slice(0, 24)} devices=${allDeviceKeys().length}`
        )
        this.close()
        return
      }
      console.log(
        `[companion] conn ${this.id}: identified as ${this.pairing ? 'pairing' : this.deviceId}`
      )
    }
    const plain = this.opener!.open(data)
    if (plain === null) {
      console.log(
        `[companion] conn ${this.id}: frame from ${this.deviceId ?? 'pairing'} did not open (${data.length} chars) — closing`
      )
      this.close()
      return
    }
    let frame: ClientFrame
    try {
      frame = JSON.parse(plain)
    } catch {
      return
    }
    await this.handle(frame)
  }

  private identify(data: string): boolean {
    const m = machineId()
    const aad = aadFor(m, 'p2m')
    const pending = pendingPairing()
    if (pending && probe(pending.keys.p2m, aad, data)) {
      this.bind(pending.keys)
      this.pairing = true
      return true
    }
    for (const { id, keys } of allDeviceKeys()) {
      if (probe(keys.p2m, aad, data)) {
        this.bind(keys)
        this.deviceId = id
        return true
      }
    }
    return false
  }

  private bind(keys: DeviceKeys): void {
    const m = machineId()
    this.keys = keys
    this.sealer = new Sealer(keys.m2p, aadFor(m, 'm2p'))
    this.opener = new Opener(keys.p2m, aadFor(m, 'p2m'))
  }

  private async handle(frame: ClientFrame): Promise<void> {
    if (this.pairing) {
      if (frame.t !== 'pair') return
      const pending = pendingPairing()
      if (!pending) {
        this.send({ t: 'bye', reason: 'pairing-closed' })
        this.close()
        return
      }
      offerPairing(frame.device, (accepted) => {
        if (!accepted) {
          this.send({ t: 'bye', reason: 'pairing-closed' })
          this.close()
          return
        }
        const token = newToken()
        addDevice(frame.device, pending.secret, token)
        this.deviceId = frame.device.id
        this.pairing = false
        cancelPairing()
        this.send({ t: 'paired', token, machine: machineInfo() })
        this.onAuthed(this)
      })
      return
    }

    if (frame.t === 'hello') {
      if (frame.v !== PROTOCOL_VERSION) {
        this.send({ t: 'bye', reason: 'version' })
        this.close()
        return
      }
      if (
        !this.deviceId ||
        frame.device !== this.deviceId ||
        !tokenMatches(this.deviceId, frame.token)
      ) {
        this.send({ t: 'bye', reason: 'unauthorized' })
        this.close()
        return
      }
      touchDevice(this.deviceId)
      this.send({ t: 'welcome', machine: machineInfo(), tree: listTree(), chats: listChats() })
      // What each conversation already has open, so the phone can show the page
      // above its chat without waiting for the next navigation.
      for (const { paneId, state } of openPanes()) {
        const browser = wireBrowser(paneId, state)
        if (browser?.open) this.send({ t: 'browser', browser })
      }
      // And the simulators, so a phone opening a chat with a device on screen
      // shows it straight away rather than after the next boot.
      for (const { chatId, udid } of openSimulators()) {
        void deviceLabel(udid).then((device) =>
          this.send({ t: 'simulator', simulator: { chatId, open: true, udid, device } })
        )
      }
      this.onAuthed(this)
      return
    }

    if (!this.authenticated) return

    switch (frame.t) {
      case 'subscribe': {
        this.subs.add(frame.chatId)
        let after = frame.afterSeq
        // The phone holds a log this chat no longer has (it was cleared):
        // have it drop that, and send the conversation from the start.
        if (logDiverged(frame.chatId, after, frame.afterTs)) {
          this.send({ t: 'reset', chatId: frame.chatId })
          after = 0
        }
        if (after === 0 && typeof frame.tail === 'number' && frame.tail > 0)
          after = tailStart(frame.chatId, frame.tail)
        // Replay everything the phone missed, in order, until we're caught up.
        this.startReplay(frame.chatId, after)
        return
      }
      case 'unsubscribe':
        this.subs.delete(frame.chatId)
        this.stopReplay(frame.chatId)
        return
      case 'ping':
        this.send({ t: 'pong' })
        return
      case 'req': {
        if (frame.method === 'device.presence') {
          const p = frame.params as
            { active?: boolean; pushToken?: string; pushEnv?: 'production' | 'sandbox' } | undefined
          this.presenceActive = p?.active === true
          if (this.deviceId && typeof p?.pushToken === 'string')
            setPushToken(this.deviceId, p.pushToken, p.pushEnv ?? 'production')
          this.send({ t: 'res', id: frame.id, ok: true })
          return
        }
        // Handled here, not in the RPC table: it needs to know which phone
        // wrote, so that phone is not sent its own words back.
        if (frame.method === 'chat.draft') {
          const p = frame.params as { chatId?: unknown; text?: unknown } | undefined
          if (typeof p?.chatId !== 'string' || typeof p.text !== 'string') {
            this.send({
              t: 'res',
              id: frame.id,
              ok: false,
              error: { code: 'bad-params', message: 'chatId and text' }
            })
            return
          }
          saveDraft(p.chatId, p.text, this)
          this.send({ t: 'res', id: frame.id, ok: true })
          return
        }
        const res = await handleRpc(frame.method, frame.params)
        this.send(
          res.ok
            ? { t: 'res', id: frame.id, ok: true, result: res.result }
            : { t: 'res', id: frame.id, ok: false, error: res.error }
        )
        return
      }
      default:
        return
    }
  }
}

export function machineInfo(): WireMachine {
  return { name: prettyHostname(), appVersion: app.getVersion(), protocol: PROTOCOL_VERSION }
}
