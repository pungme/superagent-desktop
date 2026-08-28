import { app } from 'electron'
import { Sealer, Opener, aadFor, probe, newToken, DeviceKeys } from './crypto'
import { machineId } from './identity'
import { addDevice, allDeviceKeys, tokenMatches, touchDevice, setPushToken } from './devices'
import { pendingPairing, offerPairing, cancelPairing, prettyHostname } from './pairing'
import { eventsAfter } from './log'
import { handleRpc, listTree, listChats } from './rpc'
import type { RelayClient } from './relay-client'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type WireMachine
} from '../../shared/companion-protocol'

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
    this.relay.closeConn(this.id)
    this.onClosed(this)
  }

  /** Called by the relay client when the phone went away. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.onClosed(this)
  }

  async receive(data: string): Promise<void> {
    if (this.closed) return
    if (!this.keys) {
      if (!this.identify(data)) {
        // Nobody's key opens this — not our phone. Drop the connection.
        this.close()
        return
      }
    }
    const plain = this.opener!.open(data)
    if (plain === null) {
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
      this.onAuthed(this)
      return
    }

    if (!this.authenticated) return

    switch (frame.t) {
      case 'subscribe': {
        this.subs.add(frame.chatId)
        let after = frame.afterSeq
        // Replay everything the phone missed, in order, until we're caught up.
        for (let i = 0; i < 20; i++) {
          const { events, hasMore } = eventsAfter(frame.chatId, after)
          for (const event of events) this.send({ t: 'event', event })
          if (!events.length || !hasMore) break
          after = events[events.length - 1].seq
        }
        return
      }
      case 'unsubscribe':
        this.subs.delete(frame.chatId)
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
