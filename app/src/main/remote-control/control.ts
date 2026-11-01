import {
  coverOthers,
  NOTIFICATION_HOST,
  isSelfApp,
  launcherApp,
  offLimitsApp,
  overlaps,
  shellApp,
  type AppRef,
  type LaidWindow,
  type ScreenArea
} from '../../shared/computer-use'
import {
  REMOTE_ASK_MS,
  REMOTE_ASK_WINDOW_MS,
  REMOTE_BUCKET_BURST,
  REMOTE_BUCKET_RATE,
  REMOTE_CODE_TRIES,
  REMOTE_IDLE_MS,
  REMOTE_MAX_MS,
  REMOTE_MIN_GAP_MS,
  REMOTE_LAUNCH_SETTLE_MS,
  REMOTE_SETTLE_MS,
  REMOTE_SETTLE_READS,
  REMOTE_SETTLE_STEP_MS,
  REMOTE_SILENT_MS,
  REMOTE_TEXT_BURST,
  REMOTE_TEXT_RATE,
  SPAWNS_AT,
  SPAWNS_FRONT,
  SPAWNS_HELPER,
  SPAWNS_SCENE,
  TokenBucket,
  askBudgetLeftAt,
  cleanDeviceName,
  cursorOnPicture,
  inAppleMenu,
  launcherOnScreen,
  onDock,
  ownModalUp,
  pastes,
  lockedUntil,
  newCode,
  remoteKey,
  sameCode
} from '../../shared/remote-control'
import type {
  RemoteEndReason,
  RemoteInputAction,
  RemotePause,
  RemoteRefusedReason,
  ServerFrame,
  WireRemote
} from '../../shared/companion-protocol'
import { toStep, type Held, type Step } from './input'
import { Governor, ScreenEncoder, mayStream, type Bitmap, type Encode } from './stream'

/**
 * Remote control: the phone as this Mac's screen, trackpad and keyboard.
 *
 * The rules, in the order they matter:
 *
 *  1. Off unless switched on at the Mac (`setEnabled`, reached only through
 *     main's IPC). Switching it off ends everything.
 *  2. A session is allowed at the Mac, by a click in a native dialog that
 *     nothing on the phone can answer (`askAllow` is a dependency, answered by
 *     the Mac's own dialog; no RPC reaches it), and then the phone has to type
 *     the code a second dialog shows. Three wrong tries, three turned-down
 *     requests, or a request that sits for two minutes burn it; enough of those
 *     lock requests out for a while.
 *  3. While it runs, a banner is on screen that remote input cannot touch,
 *     ⌥Esc ends it, and it ends when the phone goes, after ten idle minutes,
 *     when the Mac sleeps or locks, when the banner is lost, or when the
 *     switch goes off.
 *  4. Every action is checked against the Mac as it is at that moment: not
 *     into Superagent's own windows, nothing while a password manager, Keychain
 *     or the lock screen is in front or under the pointer, no key that opens
 *     Force Quit or logs out or is one of Superagent's own shortcuts. Nor into
 *     a terminal or scripting app (a shell is everything the rest guards)
 *     unless that was allowed at the Mac. After a click or a key that can change
 *     the app in front, the next action waits until it has. The stream is
 *     checked the same way and shows Superagent's windows covered.
 *
 * This module touches the Mac only through `RemoteDeps`, so the whole of it is
 * tested with fakes and no screen, mouse or keyboard.
 */

export interface DisplayInfo {
  id: number
  name: string
  bounds: ScreenArea
}

export interface RemoteDeps {
  now(): number
  /** A random integer in [0, n). */
  below(n: number): number
  /** One frame to one phone connection. */
  send(connId: string, frame: ServerFrame): void
  /** Tell every connected phone where Remote control stands for it. */
  pushAll(wire: (connId: string) => WireRemote): void
  alive(connId: string): boolean
  /** Bytes the relay socket has not taken yet. */
  backlog(): number
  /**
   * The Mac's own question: "Allow <device> to control this Mac?". Answered by
   * a click at the Mac and by nothing else; aborting the signal closes it.
   */
  askAllow(q: {
    deviceName: string
    /** Whether terminals and scripting apps are allowed, for the dialog to say so. */
    shells: boolean
    displays: DisplayInfo[]
    signal: AbortSignal
  }): Promise<{ allow: false } | { allow: true; displayId: number }>
  /** The code, on the Mac's screen. Resolves when it is closed, by the user or the signal. */
  showCode(q: { deviceName: string; code: string; signal: AbortSignal }): Promise<void>
  displays(): DisplayInfo[]
  /** Why remote control cannot run (permissions, helper), or null. */
  notReady(): string | null
  front(): Promise<AppRef | null>
  /** Every window on screen, front to back. Throws when it cannot be listed. */
  layout(): Promise<LaidWindow[]>
  /** The app whose window is at a point; null for the desktop or menu bar. Throws when it cannot be told: that refuses, never falls back to the app in front. */
  appAt(x: number, y: number): Promise<AppRef | null>
  /** The pasteboard carries a type that marks it a secret (a password manager's copy). Names only, never contents. */
  clipboardConcealed(): boolean
  /** The point is on one of Superagent's own floating windows. */
  ownSurfaceAt(x: number, y: number): boolean
  /** One of Superagent's own windows has the keyboard. */
  ownFocused(): boolean
  ownShortcuts(): string[]
  /** The user's keep-out list, shared with computer use. */
  denied(): AppRef[]
  /** The helper, one action. */
  run(args: string[]): Promise<{ ok: boolean; error: string }>
  /** Cut short any helper run that is posting events. How many were cut short. */
  killRunning(): number
  cursor(): { x: number; y: number } | null
  capture(display: DisplayInfo, width: number): Promise<Bitmap>
  encode: Encode
  banner: {
    show(info: { deviceName: string; display: DisplayInfo; displays: DisplayInfo[] }): boolean
    hide(): void
    ok(): boolean
  }
  /** `hold` is false when macOS would not give us ⌥Esc. */
  stopKey: { hold(): boolean; release(): void }
  /** The app's log. Never given typed text. */
  log(line: string): void
  /** For the Settings window. */
  changed(): void
}

/** The phone that is talking: its connection and the paired device behind it. */
export interface Caller {
  connId: string
  deviceId: string
}

/** An action that was not done, and why, in words the phone can show. */
export class RemoteRefusal extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message)
  }
}

interface Pending {
  connId: string
  deviceId: string
  deviceName: string
  state: 'allow' | 'code'
  code: string
  displayId: number
  tries: number
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
}

interface Queued {
  a: RemoteInputAction
  resolve: () => void
  reject: (e: unknown) => void
}

interface Session {
  connId: string
  deviceId: string
  deviceName: string
  display: DisplayInfo
  startedAt: number
  lastInputAt: number
  lastHeardAt: number
  held: Held | null
  bucket: TokenBucket
  textBucket: TokenBucket
  /** The app in front was read twice, the same, after the last action that could change it. */
  confirmed: boolean
  queue: Queued[]
  draining: boolean
  watch: ReturnType<typeof setInterval>
  pumpTimer: ReturnType<typeof setTimeout> | null
  pumping: boolean
  visible: boolean
  paused: RemotePause | null
  pausedBy: string
  encoder: ScreenEncoder
  governor: Governor
  lastCursor: { x: number; y: number } | null
  lastSeq: number
  actions: number
  refused: number
  frames: number
  bytes: number
  refusedLoggedAt: Map<string, number>
  /** Looks that failed in a row: the screen cannot be captured (Screen Recording says yes and means no). */
  failures: number
  /** What the last look found on screen, and when: a look a moment later does not ask again. */
  seen: { at: number; scene: Awaited<ReturnType<RemoteControl['scene']>> } | null
}

/** Typed text goes in pieces this long, and the app in front is looked at between them. */
const TEXT_PIECE = 24

/** Text in pieces of TEXT_PIECE characters, never splitting a character. */
export function textPieces(text: string): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += TEXT_PIECE)
    out.push(chars.slice(i, i + TEXT_PIECE).join(''))
  return out
}

export class RemoteControl {
  private enabled = false
  private pending: Pending | null = null
  private session: Session | null = null
  private shells = false
  /** Per paired device: one phone's turned-down requests do not lock another phone out. */
  private strikes = new Map<string, number[]>()
  private lastAskAt = new Map<string, number>()
  /** Every dialog a device made the Mac show, cancelled ones too. */
  private asks = new Map<string, number[]>()
  /** How the last session or request of each phone ended, for it to be told. */
  private outcomes = new Map<string, RemoteEndReason | RemoteRefusedReason>()

  constructor(private d: RemoteDeps) {}

  // --- the switch ------------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled
  }

  /** Switched on or off at the Mac. Off ends a session and cancels a request at once. */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) {
      this.shells = false
      this.end('turned-off')
      this.cancel('cancelled')
    }
    this.announce()
  }

  /** Whether a phone may use terminals and scripting apps. Set at the Mac only, and off whenever remote control goes off. */
  shellsAllowed(): boolean {
    return this.shells
  }

  setShells(on: boolean): void {
    this.shells = on && this.enabled
    this.announce()
  }

  /** The phone's view of it. `connId` null: a phone with no part in it. */
  wire(connId: string | null): WireRemote {
    if (!this.enabled) return { available: false, state: 'idle' }
    const base: WireRemote = { available: true, state: 'idle' }
    const note = this.d.notReady()
    if (note) base.note = note
    const outcome = connId ? this.outcomes.get(connId) : undefined
    if (outcome) base.ended = outcome
    const s = this.session
    if (s && s.connId === connId) {
      return {
        ...base,
        state: 'active',
        ended: null,
        display: {
          name: s.display.name,
          width: s.display.bounds.width,
          height: s.display.bounds.height
        },
        paused: s.paused,
        ...(s.pausedBy ? { pausedBy: s.pausedBy } : {})
      }
    }
    const p = this.pending
    if (p && p.connId === connId)
      return {
        ...base,
        state: p.state === 'allow' ? 'asking' : 'code',
        ended: null,
        ...(p.state === 'code' ? { triesLeft: REMOTE_CODE_TRIES - p.tries } : {})
      }
    return base
  }

  /** What Settings shows. */
  summary(): {
    enabled: boolean
    shells: boolean
    active: boolean
    asking: boolean
    device: string
    since: number
    paused: RemotePause | null
  } {
    const s = this.session
    return {
      enabled: this.enabled,
      shells: this.shells,
      active: !!s,
      asking: !!this.pending,
      device: s?.deviceName ?? this.pending?.deviceName ?? '',
      since: s?.startedAt ?? 0,
      paused: s?.paused ?? null
    }
  }

  private announce(): void {
    this.d.pushAll((id) => this.wire(id))
    this.d.changed()
  }

  // --- asking ------------------------------------------------------------------

  /** A phone asks to start. Only starts the question at the Mac. */
  request(who: { connId: string; deviceId: string; deviceName: string }): WireRemote {
    const now = this.d.now()
    if (!this.enabled) throw new RemoteRefusal('off', 'Remote control is off on this Mac.')
    const notReady = this.d.notReady()
    if (notReady) throw new RemoteRefusal('not-ready', notReady)
    if (this.session || this.pending)
      throw new RemoteRefusal('busy', 'This Mac is already answering a phone.')
    const lock = lockedUntil(this.strikes.get(who.deviceId) ?? [], now)
    if (lock !== null)
      throw new RemoteRefusal(
        'locked-out',
        `Too many requests were turned down. Try again in ${Math.ceil((lock - now) / 60_000)} minutes.`
      )
    if (now - (this.lastAskAt.get(who.deviceId) ?? -Infinity) < REMOTE_MIN_GAP_MS)
      throw new RemoteRefusal('too-many', 'Wait a few seconds before asking again.')
    // However each one ended (denied, expired, or cancelled by hanging up), a
    // phone gets only so many dialogs on this Mac's screen an hour.
    const recent = (this.asks.get(who.deviceId) ?? []).filter((t) => now - t < REMOTE_ASK_WINDOW_MS)
    const freeAt = askBudgetLeftAt(recent, now)
    if (freeAt !== null)
      throw new RemoteRefusal(
        'too-many',
        `This phone has asked too often. Try again in ${Math.ceil((freeAt - now) / 60_000)} minutes.`
      )
    this.asks.set(who.deviceId, [...recent, now])
    this.lastAskAt.set(who.deviceId, now)
    const name = cleanDeviceName(who.deviceName)
    const abort = new AbortController()
    const p: Pending = {
      connId: who.connId,
      deviceId: who.deviceId,
      deviceName: name,
      state: 'allow',
      code: '',
      displayId: 0,
      tries: 0,
      abort,
      timer: setTimeout(() => this.refuse(p, 'expired'), REMOTE_ASK_MS)
    }
    this.pending = p
    this.outcomes.delete(who.connId)
    this.d.log(`remote: request from "${name}"`)
    void this.askAtMac(p)
    this.announce()
    return this.wire(who.connId)
  }

  private async askAtMac(p: Pending): Promise<void> {
    let answer: Awaited<ReturnType<RemoteDeps['askAllow']>>
    try {
      answer = await this.d.askAllow({
        deviceName: p.deviceName,
        shells: this.shells,
        displays: this.d.displays(),
        signal: p.abort.signal
      })
    } catch {
      answer = { allow: false }
    }
    if (this.pending !== p || p.abort.signal.aborted) return
    if (!answer.allow) return this.refuse(p, 'denied')
    p.state = 'code'
    p.displayId = answer.displayId
    p.code = newCode((n) => this.d.below(n))
    clearTimeout(p.timer)
    p.timer = setTimeout(() => this.refuse(p, 'expired'), REMOTE_ASK_MS)
    void this.d
      .showCode({ deviceName: p.deviceName, code: p.code, signal: p.abort.signal })
      .then(() => {
        // Closed at the Mac without the code being typed: not wanted after all.
        if (this.pending === p && p.state === 'code' && !p.abort.signal.aborted)
          this.refuse(p, 'cancelled')
      })
      .catch(() => undefined)
    this.announce()
  }

  /** The code, from the phone. Starts the session when it is right. */
  code(who: Caller, typed: string): WireRemote {
    const connId = who.connId
    const p = this.pending
    if (!this.enabled) throw new RemoteRefusal('off', 'Remote control is off on this Mac.')
    if (!p || p.connId !== connId || p.deviceId !== who.deviceId)
      throw new RemoteRefusal('no-request', 'There is nothing to confirm.')
    // Nobody has allowed it at the Mac yet: there is no code to type, and a
    // guess costs nothing and means nothing. Not counted.
    if (p.state === 'allow') return this.wire(connId)
    if (!sameCode(typed, p.code)) {
      p.tries++
      this.d.log(`remote: wrong code from "${p.deviceName}" (${p.tries} of ${REMOTE_CODE_TRIES})`)
      if (p.tries >= REMOTE_CODE_TRIES) {
        this.refuse(p, 'wrong-code')
        throw new RemoteRefusal('wrong-code', 'That was the third wrong code. Ask again.')
      }
      this.announce()
      throw new RemoteRefusal(
        'wrong-code',
        `That is not the code on the Mac. ${REMOTE_CODE_TRIES - p.tries} ${REMOTE_CODE_TRIES - p.tries === 1 ? 'try' : 'tries'} left.`
      )
    }
    this.start(p)
    return this.wire(connId)
  }

  private cancel(why: RemoteRefusedReason): void {
    const p = this.pending
    if (p) this.drop(p, why, false)
  }

  private refuse(p: Pending, why: RemoteRefusedReason): void {
    if (this.pending !== p) return
    this.drop(p, why, why !== 'cancelled')
  }

  private drop(p: Pending, why: RemoteRefusedReason, strike: boolean): void {
    clearTimeout(p.timer)
    p.abort.abort()
    this.pending = null
    this.outcomes.set(p.connId, why)
    if (strike)
      this.strikes.set(p.deviceId, [...(this.strikes.get(p.deviceId) ?? []), this.d.now()])
    this.d.log(`remote: request from "${p.deviceName}" not allowed (${why})`)
    this.announce()
  }

  // --- the session -------------------------------------------------------------

  private start(p: Pending): void {
    clearTimeout(p.timer)
    p.abort.abort()
    this.pending = null
    const fail = (why: RemoteEndReason | RemoteRefusedReason, line: string): void => {
      this.outcomes.set(p.connId, why)
      this.d.log(`remote: ${line}`)
      this.announce()
    }
    const display = this.d.displays().find((x) => x.id === p.displayId)
    if (!display) return fail('display-gone', 'session not started: the display is gone')
    if (this.d.notReady()) return fail('permissions', 'session not started: permissions missing')
    if (!this.d.alive(p.connId)) return fail('phone-left', 'session not started: the phone left')
    // ⌥Esc is the way to end it from the Mac whatever is on screen; if macOS
    // would not give it to us, there is no session.
    if (!this.d.stopKey.hold()) {
      this.d.stopKey.release()
      return fail('no-stop-key', 'session not started: ⌥Esc could not be held')
    }
    // The banner is what tells whoever is at the Mac; no banner, no session.
    if (!this.d.banner.show({ deviceName: p.deviceName, display, displays: this.d.displays() })) {
      this.d.stopKey.release()
      return fail('banner-lost', 'session not started: the banner could not be shown')
    }
    const now = this.d.now()
    const s: Session = {
      connId: p.connId,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      display,
      startedAt: now,
      lastInputAt: now,
      lastHeardAt: now,
      held: null,
      bucket: new TokenBucket(REMOTE_BUCKET_RATE, REMOTE_BUCKET_BURST, now),
      textBucket: new TokenBucket(REMOTE_TEXT_RATE, REMOTE_TEXT_BURST, now),
      confirmed: true,
      queue: [],
      draining: false,
      watch: setInterval(() => this.watchSession(s), 1000),
      pumpTimer: null,
      pumping: false,
      visible: true,
      paused: null,
      pausedBy: '',
      encoder: new ScreenEncoder(this.d.encode),
      governor: new Governor(),
      lastCursor: null,
      lastSeq: 0,
      actions: 0,
      refused: 0,
      frames: 0,
      bytes: 0,
      refusedLoggedAt: new Map(),
      failures: 0,
      seen: null
    }
    this.session = s
    this.outcomes.delete(p.connId)
    this.d.log(`remote: session started for "${s.deviceName}" on display "${display.name}"`)
    this.announce()
    this.schedule(s, 0)
  }

  /** The phone said something: it is still there. */
  heard(connId: string): void {
    if (this.session?.connId === connId) this.session.lastHeardAt = this.d.now()
  }

  /** The phone's connection went. */
  connGone(connId: string): void {
    if (this.session?.connId === connId) this.end('phone-left')
    if (this.pending?.connId === connId) this.cancel('cancelled')
  }

  private watchSession(s: Session): void {
    if (this.session !== s) return
    const now = this.d.now()
    if (!this.d.alive(s.connId)) return this.end('phone-left')
    if (now - s.lastHeardAt > REMOTE_SILENT_MS) return this.end('phone-silent')
    if (now - s.lastInputAt > REMOTE_IDLE_MS) return this.end('idle')
    if (now - s.startedAt > REMOTE_MAX_MS) return this.end('too-long')
    if (!this.d.banner.ok()) return this.end('banner-lost')
    const display = this.d.displays().find((x) => x.id === s.display.id)
    if (!display) return this.end('display-gone')
    s.display = display
    if (this.d.notReady()) return this.end('permissions')
  }

  /** End the session, whoever's it is. A no-op when there is none. */
  end(reason: RemoteEndReason): void {
    const s = this.session
    if (!s) return
    this.session = null
    clearInterval(s.watch)
    if (s.pumpTimer) clearTimeout(s.pumpTimer)
    // Whatever the helper is posting right now stops here.
    const killed = this.d.killRunning()
    // A button the phone was holding is let go where it went down, not left held.
    // And a run cut short between a button's down and up (a tap, a drag) leaves
    // one held that s.held does not know of: let go of each, where the pointer is.
    const buttons = killed > 0 ? ['left', 'right'] : s.held ? [s.held.button] : []
    const at = s.held?.at ?? this.d.cursor()
    if (at) for (const b of buttons) void this.d.run(['up', String(at.x), String(at.y), b])
    for (const q of s.queue.splice(0)) q.reject(new RemoteRefusal('ended', 'The session ended.'))
    this.d.banner.hide()
    this.d.stopKey.release()
    this.outcomes.set(s.connId, reason)
    this.d.log(
      `remote: session ended (${reason}) after ${Math.round((this.d.now() - s.startedAt) / 1000)}s: ${s.actions} actions, ${s.refused} refused, ${s.frames} frames, ${Math.round(s.bytes / 1024)} KB`
    )
    this.announce()
  }

  /** The phone says it is done. */
  endFromPhone(who: Caller): void {
    const s = this.session
    if (s && s.connId === who.connId && s.deviceId === who.deviceId) this.end('stopped-on-phone')
    // A request still waiting at the Mac: the phone has had second thoughts, and
    // the questions on the Mac's screen close (no strike: nobody was turned down).
    const p = this.pending
    if (p && p.connId === who.connId && p.deviceId === who.deviceId) this.cancel('cancelled')
  }

  private mine(who: Caller): Session {
    if (!this.enabled) throw new RemoteRefusal('off', 'Remote control is off on this Mac.')
    const s = this.session
    if (!s || s.connId !== who.connId || s.deviceId !== who.deviceId)
      throw new RemoteRefusal('no-session', 'There is no session.')
    s.lastHeardAt = this.d.now()
    return s
  }

  /** How the phone wants the stream, and that it is still there. */
  view(who: Caller, v: { visible?: boolean; maxWidth?: number; key?: boolean }): void {
    const s = this.mine(who)
    if (v.visible !== undefined) {
      const was = s.visible
      s.visible = v.visible
      if (v.visible && !was) {
        s.encoder.needKey()
        this.schedule(s, 0)
      }
    }
    if (v.maxWidth !== undefined) s.governor.phoneMax = v.maxWidth
    if (v.key) {
      s.encoder.needKey()
      this.kick(s)
    }
  }

  // --- input -------------------------------------------------------------------

  /**
   * The phone's actions, applied one after another, each only after being
   * checked against the Mac as it is then. Stops at the first one refused.
   */
  async input(who: Caller, actions: RemoteInputAction[]): Promise<{ done: number }> {
    const s = this.mine(who)
    // A run of moves is only the last of them: the pointer is where it ends.
    const batch = actions.filter((a, i) => !(a.type === 'move' && actions[i + 1]?.type === 'move'))
    let done = 0
    for (const a of batch) {
      await this.enqueue(s, a)
      done++
    }
    return { done }
  }

  private enqueue(s: Session, a: RemoteInputAction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.session !== s) return reject(new RemoteRefusal('ended', 'The session ended.'))
      const last = s.queue[s.queue.length - 1]
      if (a.type === 'move' && last && last.a.type === 'move') {
        // Not started yet and already out of date.
        last.resolve()
        s.queue[s.queue.length - 1] = { a, resolve, reject }
        return
      }
      if (s.queue.length >= 64)
        return reject(new RemoteRefusal('rate-limited', 'Too much at once.'))
      s.queue.push({ a, resolve, reject })
      void this.drain(s)
    })
  }

  private async drain(s: Session): Promise<void> {
    if (s.draining) return
    s.draining = true
    try {
      while (s.queue.length && this.session === s) {
        const item = s.queue.shift()!
        try {
          await this.apply(s, item.a)
          item.resolve()
        } catch (e) {
          item.reject(e)
        }
      }
    } finally {
      s.draining = false
      if (this.session !== s)
        for (const q of s.queue.splice(0))
          q.reject(new RemoteRefusal('ended', 'The session ended.'))
    }
  }

  private refusal(
    s: Session,
    a: RemoteInputAction,
    reason: string,
    message: string
  ): RemoteRefusal {
    s.refused++
    // One line a few seconds for one reason: a finger resting on a password
    // manager is sixty refusals a second.
    const now = this.d.now()
    if (now - (s.refusedLoggedAt.get(reason) ?? 0) > 5000) {
      s.refusedLoggedAt.set(reason, now)
      this.d.log(`remote: refused ${a.type} (${reason})`)
    }
    return new RemoteRefusal(reason, message)
  }

  /**
   * The app is one remote control does not act in. Throws. This is the one place
   * that says which apps are in bounds (and `scene` and the cover predicate in
   * `look` say the same for the picture): an optional "only these apps" mode
   * would be one more rule here, not a new mechanism.
   */
  private checkApp(s: Session, a: RemoteInputAction, app: AppRef): void {
    if (isSelfApp(app.id))
      throw this.refusal(
        s,
        a,
        'own-window',
        "Superagent's own window is in the way on the Mac. Remote control does not use it."
      )
    if (!this.shells) {
      const shell = shellApp(app.id)
      if (shell)
        throw this.refusal(
          s,
          a,
          'shell',
          `${app.name} is ${shell}, and it can run commands as you. Remote control does not use it unless you allow that on the Mac (Settings → Phone).`
        )
    }
    const name = offLimitsApp(app.id, this.d.denied())
    if (name)
      throw this.refusal(
        s,
        a,
        name === 'the lock screen' ? 'lock' : 'secret',
        name === 'the lock screen'
          ? 'The Mac is at its lock screen.'
          : `${name} is in the way on the Mac. Remote control does not use it; do that part at the Mac.`
      )
  }

  /** A key that can bring another app to the front: any with Command, Control, Option or Fn. */
  private modded(a: RemoteInputAction): boolean {
    return a.type === 'key' && (a.mods ?? []).some((m) => m !== 'shift')
  }

  private async apply(s: Session, a: RemoteInputAction): Promise<void> {
    const area = this.d.displays().find((x) => x.id === s.display.id)?.bounds
    if (!area) {
      this.end('display-gone')
      throw new RemoteRefusal('ended', 'The shared display is gone.')
    }
    // The last thing done may still be changing the app in front: look again
    // until it has stopped before anything is checked or pressed.
    if (!s.confirmed) await this.settle(s, 0)
    let step: Step
    if (a.type === 'key') {
      const v = remoteKey(a.key, a.mods ?? [], this.d.ownShortcuts())
      if (!v.ok) throw this.refusal(s, a, 'blocked-key', `Not pressed: ${v.why}.`)
      if (!s.confirmed && (this.modded(a) || a.key === 'return'))
        throw this.refusal(
          s,
          a,
          'settling',
          'The Mac is still switching apps, so that key was not pressed. Try again in a moment.'
        )
      // A secret just copied from a password manager must not be pasted into a
      // field the picture then shows.
      if (pastes(a.key, a.mods ?? []) && this.d.clipboardConcealed())
        throw this.refusal(
          s,
          a,
          'clipboard',
          'The clipboard holds something a password manager copied, so it was not pasted.'
        )
      step = { args: ['key', v.combo], points: [], kind: 'keys' }
    } else step = toStep(a, area, s.held)
    // Typed text goes in pieces, and the Mac is looked at again before each.
    const pieces = a.type === 'text' ? textPieces(a.text) : [null]
    // Charged for what it costs the Mac: a process for each look at the app in
    // front (two), at the point (one), and the helper (one); a settle afterwards
    // looks twice more. Per piece, not per action.
    const presses = a.type === 'click' || a.type === 'down' || a.type === 'up' || a.type === 'drag'
    const settles = presses || this.modded(a) || (a.type === 'key' && a.key === 'return')
    const spawns =
      pieces.length * (SPAWNS_SCENE + SPAWNS_HELPER) +
      step.points.length * SPAWNS_AT +
      (settles ? 2 * SPAWNS_FRONT : 0)
    const now = this.d.now()
    if (a.type === 'text' && !s.textBucket.take(Array.from(a.text).length, now))
      throw this.refusal(s, a, 'rate-limited', 'Typing too fast. Slow down a moment.')
    if (!s.bucket.take(spawns, now))
      throw this.refusal(s, a, 'rate-limited', 'Too fast. Slow down a moment.')
    let seen: { front: AppRef; windows: LaidWindow[] } | null = null
    for (const piece of pieces) {
      seen = await this.guard(s, a, step, area)
      if (this.session !== s) throw new RemoteRefusal('ended', 'The session ended.')
      const r = await this.d.run(piece === null ? step.args : ['type', piece])
      // Never the helper's own words: they can carry what was typed.
      if (!r.ok) throw this.refusal(s, a, 'failed', 'The Mac did not do that.')
    }
    if (a.type === 'down') s.held = { button: a.button ?? 'left', at: step.points[0] }
    else if (a.type === 'up' || a.type === 'click') s.held = null
    s.actions++
    s.lastInputAt = this.d.now()
    // What it did may bring another app forward, a moment later: nothing else
    // is done until that has happened. An app that opens another (Return in
    // Spotlight, a double click, ⌘O) is given longer.
    if (settles) {
      // A launcher is up (Spotlight may not be reported as the app in front, so
      // its window is looked for too), or the click is on the Dock: what it opens
      // arrives late.
      const launching = !!seen && (launcherApp(seen.front.id) || launcherOnScreen(seen.windows))
      const opens =
        (a.type === 'key' &&
          (a.key === 'return' || a.key === 'o' || a.key === 'down') &&
          (launching || (a.mods ?? []).includes('cmd'))) ||
        (a.type === 'click' &&
          ((a.count ?? 1) > 1 ||
            launching ||
            step.points.some((pt) => !!seen && onDock(seen.windows, pt))))
      await this.settle(s, opens ? REMOTE_LAUNCH_SETTLE_MS : REMOTE_SETTLE_MS)
    }
    this.kick(s)
  }

  /**
   * Wait for the app in front to stop changing: read it, and again a moment
   * later, until two readings agree. Not agreeing after a few tries leaves the
   * session unconfirmed, and keys that move between apps are refused until it is.
   */
  private async settle(s: Session, wait: number): Promise<void> {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    if (wait) await sleep(wait)
    let prev = await this.d.front()
    for (let i = 1; i < REMOTE_SETTLE_READS; i++) {
      if (this.session !== s) return
      await sleep(REMOTE_SETTLE_STEP_MS)
      const cur = await this.d.front()
      if ((cur?.id ?? null) === (prev?.id ?? null)) {
        s.confirmed = true
        return
      }
      prev = cur
    }
    s.confirmed = false
  }

  /**
   * Whether this action may touch the Mac as it is now. Throws what the phone is
   * told. Looks at the Mac itself, every time: what is in front and every window
   * on the display, so a secret on screen stops input whether or not the phone is
   * asking for pictures and however old the stream's last look is. Returns what
   * it saw.
   */
  private async guard(
    s: Session,
    a: RemoteInputAction,
    step: Step,
    area: ScreenArea
  ): Promise<{ front: AppRef; windows: LaidWindow[] }> {
    const sc = await this.scene(area)
    const front = sc.front
    if (sc.pause === 'unknown' || !front)
      throw this.refusal(
        s,
        a,
        'unknown',
        'macOS would not say which app is in front, so nothing was done.'
      )
    this.checkApp(s, a, front)
    if (ownModalUp(sc.windows))
      throw this.refusal(
        s,
        a,
        'own-window',
        'A Superagent dialog is open on the Mac, and remote control does not use it.'
      )
    this.setPause(s, sc.pause, sc.by)
    if (sc.pause)
      throw this.refusal(
        s,
        a,
        'paused',
        sc.pause === 'lock'
          ? 'The Mac is at its lock screen.'
          : `${sc.by || 'A password manager'} is on screen on the Mac, so the screen and input are paused.`
      )
    if (step.kind === 'pointer') {
      const press = a.type === 'click' || a.type === 'down' || a.type === 'up' || a.type === 'drag'
      for (const pt of step.points) {
        if (this.d.ownSurfaceAt(pt.x, pt.y))
          throw this.refusal(s, a, 'own-window', "That is on Superagent's own window.")
        // The window under the point, which need not be the app in front. Not
        // knowing is a refusal; the desktop and the menu bar (null) are the app in front's.
        let under: AppRef | null
        try {
          under = await this.d.appAt(pt.x, pt.y)
        } catch {
          throw this.refusal(
            s,
            a,
            'unknown',
            'macOS would not say what is under that point, so nothing was done.'
          )
        }
        this.checkApp(s, a, under ?? front)
        if (press && inAppleMenu(area, pt))
          throw this.refusal(
            s,
            a,
            'system-menu',
            'The Apple menu (restart, shut down, log out) is not used by remote control.'
          )
        if (
          press &&
          onDock(sc.windows, pt) &&
          (a.type === 'down' || a.type === 'drag' || ('button' in a && a.button === 'right'))
        )
          throw this.refusal(
            s,
            a,
            'dock-menu',
            "The Dock's menu (Quit, Options) is not used by remote control; a plain click on an icon is."
          )
      }
    } else if (this.d.ownFocused())
      throw this.refusal(s, a, 'own-window', "The keyboard is in Superagent's own window.")
    return { front, windows: sc.windows }
  }

  // --- the stream --------------------------------------------------------------

  private schedule(s: Session, ms: number): void {
    if (this.session !== s) return
    if (s.pumpTimer) clearTimeout(s.pumpTimer)
    s.pumpTimer = setTimeout(() => void this.pump(s), ms)
  }

  /** Look sooner: something was just done. */
  private kick(s: Session): void {
    if (!s.pumping && s.visible) this.schedule(s, 40)
  }

  private setPause(s: Session, pause: RemotePause | null, by = ''): void {
    if (s.paused === pause && s.pausedBy === by) return
    s.paused = pause
    s.pausedBy = by
    // Whatever comes back after it starts from a whole picture.
    if (!pause) s.encoder.needKey()
    this.d.log(`remote: stream ${pause ? `paused (${pause})` : 'resumed'}`)
    this.d.pushAll((id) => this.wire(id))
  }

  /**
   * What is on the Mac's screen that remote control must not show: the app in
   * front, and every window on the shared display, against the built-in list
   * and the user's own. Cannot say: paused.
   */
  private async scene(area: ScreenArea): Promise<{
    pause: RemotePause | null
    by: string
    windows: LaidWindow[]
    front: AppRef | null
  }> {
    let front: AppRef | null
    let windows: LaidWindow[]
    try {
      ;[front, windows] = await Promise.all([this.d.front(), this.d.layout()])
    } catch {
      return { pause: 'unknown', by: '', windows: [], front: null }
    }
    if (!windows.length) return { pause: 'unknown', by: '', windows, front }
    const denied = this.d.denied()
    const here = front ? offLimitsApp(front.id, denied) : null
    if (here)
      return { pause: here === 'the lock screen' ? 'lock' : 'secret', by: here, windows, front }
    // A shell in front shows whatever it prints: nothing is sent while it is.
    if (front && !this.shells && shellApp(front.id))
      return { pause: 'secret', by: front.name, windows, front }
    for (const w of windows) {
      if (!w.app || isSelfApp(w.app.id) || !overlaps(w.frame, area)) continue
      const name = offLimitsApp(w.app.id, denied)
      if (name)
        return { pause: name === 'the lock screen' ? 'lock' : 'secret', by: name, windows, front }
    }
    return { pause: null, by: '', windows, front }
  }

  private async pump(s: Session): Promise<void> {
    if (this.session !== s || s.pumping) return
    s.pumping = true
    let delay = 500
    try {
      delay = await this.look(s)
      s.failures = 0
    } catch (e) {
      this.d.log(`remote: stream error: ${(e as Error).message}`.slice(0, 200))
      // macOS can say Screen Recording is granted and still hand back nothing
      // (until Superagent is opened again): say so rather than stream nothing.
      if (++s.failures >= 3) {
        s.pumping = false
        this.end('permissions')
        return
      }
      delay = 1000
    } finally {
      s.pumping = false
    }
    this.schedule(s, delay)
  }

  /** One look at the screen; returns how long to wait before the next. */
  private async look(s: Session): Promise<number> {
    if (!s.visible) return 500
    const display = this.d.displays().find((x) => x.id === s.display.id)
    if (!display) {
      this.end('display-gone')
      return 1000
    }
    s.display = display
    const started = this.d.now()
    // The reading taken after the last picture is good for a moment: asking
    // the Mac what is in front costs three processes, and the reading after
    // this picture is taken anyway, which is the one that decides.
    const before =
      s.seen && started - s.seen.at < 120 ? s.seen.scene : await this.scene(display.bounds)
    if (this.session !== s) return 1000
    this.setPause(s, before.pause, before.by)
    if (before.pause) return 700
    const backlog = this.d.backlog()
    if (!mayStream(backlog)) return s.governor.delay({ changed: true, workMs: 100, backlog })
    const picture = await this.d.capture(display, s.governor.captureWidth(display.bounds.width))
    // And again, after: a password manager brought forward while the picture
    // was being taken is in it, so it is thrown away.
    const after = await this.scene(display.bounds)
    s.seen = { at: this.d.now(), scene: after }
    if (this.session !== s) return 1000
    this.setPause(s, after.pause, after.by)
    if (after.pause) return 700
    // Superagent's own windows (the dialogs, the banner, Settings, the chat's
    // questions) are covered over: what covers the phone's own approvals is
    // not something it can read either.
    const shot = { width: picture.width, height: picture.height, area: display.bounds }
    // A shell behind another window is covered, not shown.
    const allowed = (id: string): boolean =>
      !isSelfApp(id) &&
      id.toLowerCase() !== NOTIFICATION_HOST &&
      !offLimitsApp(id, this.d.denied()) &&
      (this.shells || !shellApp(id))
    coverOthers(picture.data, shot, before.windows, allowed)
    coverOthers(picture.data, shot, after.windows, allowed)
    const cursor = this.d.cursor()
    const at = cursor ? cursorOnPicture(display.bounds, cursor) : null
    const made = s.encoder.make(picture, s.governor.quality, this.d.now())
    const work = this.d.now() - started
    if (made && 'tooBig' in made) {
      s.governor.after({ key: true, bytes: 0, tooBig: true })
      return 50
    }
    const moved =
      (at === null) !== (s.lastCursor === null) ||
      (at !== null &&
        s.lastCursor !== null &&
        (Math.abs(at.x - s.lastCursor.x) > 0.002 || Math.abs(at.y - s.lastCursor.y) > 0.002))
    if (made) {
      this.d.send(s.connId, {
        t: 'screen',
        frame: { ...made.frame, jpeg: made.jpeg.toString('base64'), cursor: at }
      })
      made.commit()
      s.lastCursor = at
      s.lastSeq = made.frame.seq
      s.frames++
      s.bytes += made.jpeg.length
      s.governor.after({ key: made.frame.key, bytes: made.jpeg.length })
    } else if (moved) {
      this.d.send(s.connId, {
        t: 'screen',
        frame: {
          seq: s.lastSeq,
          w: picture.width,
          h: picture.height,
          x: 0,
          y: 0,
          rw: 0,
          rh: 0,
          key: false,
          jpeg: '',
          cursor: at
        }
      })
      s.lastCursor = at
    }
    return s.governor.delay({
      changed: !!made,
      workMs: work,
      backlog: this.d.backlog(),
      bytes: made ? made.jpeg.length : 0
    })
  }
}
