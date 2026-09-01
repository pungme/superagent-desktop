import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { machineId, signNonce } from './identity'

/**
 * The Mac's one outbound connection to the relay (SPEC §1). Stays up for the
 * life of the app: reconnects with backoff, re-authenticates, and multiplexes
 * every phone that attaches as a numbered client connection.
 *
 *  'state'   { state }                  connected | reconnecting | offline
 *  'open'    { conn }                   a phone attached
 *  'msg'     { conn, data }             opaque frame from that phone
 *  'close'   { conn }                   the phone went away
 */
export type RelayState = 'connected' | 'reconnecting' | 'offline'

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null
  private url = ''
  private stopped = true
  private attempt = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private authed = false
  /** When the relay last answered a ping; a silent relay is a dead socket. */
  private lastPong = 0
  state: RelayState = 'offline'
  /** Today's traffic against the relay's daily ceiling, as the relay counts it. */
  usage: { day: string; bytes: number; limit: number } | null = null
  lastError = ''

  start(relayUrl: string): void {
    this.url = relayUrl.replace(/\/+$/, '')
    this.stopped = false
    this.attempt = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.ws?.close(1000, 'stopping')
    this.ws = null
    this.setState('offline')
  }

  /** Switch relays without restarting the app. */
  restart(relayUrl: string): void {
    this.stop()
    this.start(relayUrl)
  }

  get relayUrl(): string {
    return this.url
  }

  send(conn: string, data: string): void {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ t: 'msg', c: conn, d: data }))
  }

  closeConn(conn: string): void {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ t: 'close', c: conn }))
  }

  /** Ask the relay to send an APNs push (it holds the key). */
  push(req: Record<string, unknown>): boolean {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ t: 'push', ...req }))
    return true
  }

  /** How full the outbound socket is — used to shed streaming deltas. */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0
  }

  // Wake/network events call this: drop the current socket, reconnect now.
  kick(): void {
    if (this.stopped) return
    this.attempt = 0
    if (this.ws) this.ws.terminate()
    else this.connect()
  }

  private connect(): void {
    if (this.stopped) return
    this.clearTimers()
    this.authed = false
    // The identity lives in the keychain (safeStorage). A denied or timed-out
    // keychain prompt must not take the whole relay client down — report it
    // and try again later.
    let id: string
    try {
      id = machineId()
    } catch (e) {
      this.lastError = `can't read this Mac's identity from the keychain: ${(e as Error).message}`
      this.setState('reconnecting')
      this.scheduleReconnect()
      return
    }
    const url = `${this.url}/m/${id}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url, { handshakeTimeout: 10_000 })
    } catch (e) {
      this.lastError = (e as Error).message
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.setState(this.attempt === 0 ? 'reconnecting' : this.state)

    ws.on('message', (raw) => {
      let frame: {
        t?: string
        nonce?: string
        c?: string
        d?: string
        reason?: string
        day?: string
        bytes?: number
        limit?: number
      }
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      switch (frame.t) {
        case 'challenge':
          if (frame.nonce)
            ws.send(
              JSON.stringify({ t: 'auth', sig: signNonce(Buffer.from(frame.nonce, 'base64')) })
            )
          return
        case 'ok':
          this.authed = true
          this.attempt = 0
          this.lastError = ''
          this.setState('connected')
          this.lastPong = Date.now()
          this.pingTimer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return
            // Two unanswered pings (relay restarted, network changed under us)
            // means the TCP socket is half-open: kill it and reconnect.
            if (Date.now() - this.lastPong > 60_000) {
              this.lastError = 'relay stopped answering'
              ws.terminate()
              return
            }
            ws.send('{"t":"ping"}')
          }, 25_000)
          return
        case 'open':
          if (frame.c) this.emit('open', { conn: frame.c })
          return
        case 'msg':
          if (frame.c && typeof frame.d === 'string')
            this.emit('msg', { conn: frame.c, data: frame.d })
          return
        case 'close':
          if (frame.c) this.emit('close', { conn: frame.c })
          return
        case 'pong':
          this.lastPong = Date.now()
          return
        // What today has cost. The relay sends it unencrypted — it is the
        // relay's own bookkeeping, not a message between the Mac and a phone —
        // once per megabyte and whenever a phone joins. It matters because the
        // ceiling is real: reach it and nothing reaches the Mac at all, which
        // arrives as "your Mac is unreachable" with no way to tell why.
        case 'usage':
          if (typeof frame.bytes === 'number' && typeof frame.limit === 'number') {
            this.usage = { day: frame.day ?? '', bytes: frame.bytes, limit: frame.limit }
            this.emit('usage', this.usage)
          }
          return
        case 'bye':
          this.lastError = frame.reason ?? 'bye'
          return
        default:
          return
      }
    })
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearTimers()
      const wasAuthed = this.authed
      this.authed = false
      if (wasAuthed) this.emit('disconnected')
      if (code === 4401) this.lastError = 'relay refused our identity'
      else if (code === 4409) this.lastError = 'another Superagent connected with this identity'
      else if (reason?.length) this.lastError = reason.toString()
      this.scheduleReconnect()
    })
    ws.on('error', (e) => {
      this.lastError = e.message
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.setState('reconnecting')
    const delay =
      Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5)) * (0.75 + Math.random() / 2)
    this.attempt++
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pingTimer = null
    this.reconnectTimer = null
  }

  private setState(s: RelayState): void {
    if (s === this.state) return
    this.state = s
    this.emit('state', { state: s })
  }
}
