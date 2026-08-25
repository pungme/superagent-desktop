import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../state'

interface Device {
  udid: string
  name: string
  state: string
  runtime: string
}

interface Frame {
  url: string
  width: number
  height: number
}

/**
 * How long each streamed drag segment takes on the device. Short enough that
 * the picture keeps up with the pointer; not zero, because a swipe with no
 * duration is a teleport and iOS reads velocity to decide whether you flicked.
 */
const DRAG_SEGMENT_SECONDS = 0.03

/**
 * The screen's corner radius, as a share of the device's own width.
 *
 * A fixed pixel radius cannot be right: the mirror is drawn at whatever size
 * the pane allows, so 28px was too round when small and too square when large,
 * and wrong on an iPad either way. Real hardware measures roughly 55pt of
 * radius across a 393pt-wide iPhone, and about 18pt across an 820pt iPad;
 * older phones with a home button have square corners.
 */
function cornerShareOfWidth(width: number, height: number): number {
  if (!width || !height) return 0
  const aspect = Math.max(width, height) / Math.min(width, height)
  if (aspect >= 1.95) return 0.14 // notch / Dynamic Island iPhone
  if (aspect >= 1.6) return 0 // iPhone SE, 8 and older — square
  return 0.022 // iPad
}

/**
 * An iOS Simulator inside the app, beside the chat. Two ways to get it there:
 *
 *   mirror  the device streamed into the pane. Main prefers native/simfb, which
 *           reads the framebuffer straight out of CoreSimulator (~20fps while
 *           anything is moving, no permissions), and falls back to simctl
 *           screenshots (~2fps) if that helper isn't available.
 *   attach  Apple's window parked on top of the pane. Native speed and real
 *           touch, but it floats above the app rather than living inside it.
 *
 * Gestures go through baguette in every mode, and force an immediate grab in
 * mirror mode so the picture answers a touch straight away. Every iOS version
 * accepts them — see the note on `tappable`.
 */
export function SimulatorPane({
  visible = true,
  workspaceId,
  onClose,
  onNothingToShow
}: {
  visible?: boolean
  /** So the sidebar can say this project has a simulator attached. */
  workspaceId?: string
  /** Put the pane away. Nothing else could: there was no ✕ here at all. */
  onClose?: () => void
  /**
   * This project has no simulator of its own to show — either nothing is
   * running, or what is running belongs to another session. The pane was
   * remembered per project and never expired, so a project that saw one once
   * reopened it forever and then adopted whichever device happened to be
   * booted. Better to close than to show someone else's phone.
   */
  onNothingToShow?: () => void
}): React.JSX.Element {
  const [devices, setDevices] = useState<Device[]>([])
  const [udid, setUdid] = useState<string | null>(null)
  const [frame, setFrame] = useState<Frame | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  /**
   * Bumped to restart the stream. The native helper exits when its device goes
   * away, and nothing else in the effect's inputs changes on the way back — so
   * without this, booting the device again leaves a frozen picture.
   */
  const [reload, setReload] = useState(0)
  const [canInput, setCanInput] = useState(true)
  /** Brief acknowledgement after copying the install command. */
  const [copied, setCopied] = useState(false)
  /** The device currently being shut down, so its row can say so. */
  const [shuttingDown, setShuttingDown] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [typing, setTyping] = useState(false)
  // The pane always mirrors: it streams the framebuffer straight out of
  // CoreSimulator, needs no permissions, and doesn't fight for the real window.
  // When you actually want Apple's Simulator, the ↗ button opens it.
  /**
   * Where the last touch landed, in pixels within the stage — drawn at once.
   *
   * Pixels rather than a percentage of the picture: the picture is letterboxed
   * inside the stage (max-width/height, centred), while the ripple is
   * positioned against the stage. A percentage of one is not a percentage of
   * the other, so on any pane wider or taller than the phone the circle
   * appeared beside the finger rather than under it.
   */
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const shotRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ x: number; y: number; at: number } | null>(null)
  /** Where the device has been dragged to so far, and where the pointer is now. */
  const sentRef = useRef<{ x: number; y: number } | null>(null)
  const latestRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  /** A segment is in flight; the next one waits for its ack rather than piling up. */
  const draggingRef = useRef(false)
  const movedRef = useRef(false)
  const typeBuf = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({
    text: '',
    timer: null
  })
  // Clear a pending type-flush on unmount, so a keystroke typed just before the
  // pane closes (✕ or a chat switch) doesn't fire input at a device whose pane is
  // gone, and doesn't setState on an unmounted component.
  useEffect(
    () => () => {
      if (typeBuf.current.timer) clearTimeout(typeBuf.current.timer)
    },
    []
  )

  const device = devices.find((d) => d.udid === udid)

  /**
   * Booted first, then alphabetical. simctl lists by runtime, so the device you
   * are actually running would otherwise sit somewhere down a list of dozens.
   */
  const menuDevices = [...devices].sort(
    (a, b) =>
      Number(b.state === 'Booted') - Number(a.state === 'Booted') || a.name.localeCompare(b.name)
  )

  /** Remember the device for this project, and as the app-wide fallback. */
  const rememberDevice = useCallback(
    (udid: string): void => {
      if (workspaceId) localStorage.setItem(`cove.simDevice:${workspaceId}`, udid)
      localStorage.setItem('cove.simDevice', udid)
    },
    [workspaceId]
  )

  const refresh = useCallback(async (): Promise<Device[]> => {
    const list = await window.cove.simList()
    setDevices(list)
    return list
  }, [])

  useEffect(() => {
    void refresh().then((list) => {
      // Only a device THIS project has a claim to — one the agent used here, or
      // one you picked here. (Never fall back to "whatever is booted": that showed
      // the simulator from whatever OTHER session you were working in.)
      const mine = localStorage.getItem(`cove.simDevice:${workspaceId}`)
      // Show the claimed device while it's Booted OR still Booting — the agent
      // may have just launched it and it isn't 'Booted' yet; the frame stream
      // picks it up once it's up. Requiring 'Booted' exactly is what flashed the
      // pane open then shut. A Shutdown device (a stale claim) still closes.
      const claimed = mine
        ? list.find((d) => d.udid === mine && (d.state === 'Booted' || d.state === 'Booting'))
        : undefined
      if (claimed) setUdid(claimed.udid)
      else onNothingToShow?.()
    })
    void window.cove.simHasInput().then(setCanInput)
  }, [refresh])

  /**
   * Follow the agent onto whatever device it just used.
   *
   * The pane kept showing the device you last picked while the agent booted and
   * launched onto a different one — so you sat watching another app's screen
   * wondering where yours had gone. Whatever it just acted on is what you want
   * to see.
   */
  useEffect(() => {
    return window.cove.onOpenSimulator?.((p) => {
      if (!p.udid || p.udid === udid) return
      rememberDevice(p.udid)
      setFrame(null)
      setGone(false)
      setUdid(p.udid)
    })
  }, [udid])

  /**
   * Tell the sidebar whether a simulator is really attached here.
   *
   * "The pane was open once" is not the same thing: it is remembered per
   * project, so a phone showed against a project whose simulator had long
   * since been shut down. A device selected and still answering is the honest
   * signal, and it goes away with the pane.
   */
  const reportSim = useStore((s) => s.setSimOpen)
  useEffect(() => {
    if (!workspaceId) return
    reportSim(workspaceId, Boolean(udid) && !gone)
    return () => reportSim(workspaceId, false)
  }, [workspaceId, udid, gone, reportSim])

  /**
   * Whatever this pane ends up showing is this project's claim from now on.
   * Set here rather than only where a device is chosen, so a pane that is
   * already open records itself without waiting for the next agent action.
   */
  useEffect(() => {
    if (udid && workspaceId) rememberDevice(udid)
  }, [udid, workspaceId, rememberDevice])

  // Keep main pointed at whatever this pane is showing: the agent's simctl
  // tools said "booted", which with two simulators running would install and
  // launch on whichever one simctl picked — not the one you are watching.
  useEffect(() => {
    void window.cove.simSetCurrent?.(udid)
  }, [udid])

  // Frames only while this pane is on screen — a background stream would keep
  // shelling out to simctl for a picture nobody is looking at.
  useEffect(() => {
    if (!udid || !visible) return
    setGone(false)
    const offFrame = window.cove.onSimFrame(udid, (f) => {
      setFrame(f)
      setGone(false)
    })
    const offGone = window.cove.onSimGone(udid, () => setGone(true))
    window.cove.simStreamStart(udid, 2)
    return () => {
      window.cove.simStreamStop(udid)
      offFrame()
      offGone()
    }
  }, [udid, visible, reload])

  // Anything baguette can drive is tappable. There used to be an iOS 26+ gate
  // here, on the belief that older runtimes silently ignored input — measured
  // against 18.6 and that is simply not true: taps land and the screen reacts.
  // The gate was disabling a working feature on every older simulator.
  const tappable = canInput

  /** Rendered position → device points, which is what the injector expects. */
  const toDevice = (
    e: React.PointerEvent
  ): { x: number; y: number; w: number; h: number } | null => {
    const box = shotRef.current
    const size = frame
    if (!box || !size) return null
    const r = box.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * size.width),
      y: Math.round(((e.clientY - r.top) / r.height) * size.height),
      w: size.width,
      h: size.height
    }
  }

  const onDown = (e: React.PointerEvent): void => {
    const p = toDevice(e)
    if (p) {
      dragRef.current = { x: p.x, y: p.y, at: Date.now() }
      sentRef.current = { x: p.x, y: p.y }
      latestRef.current = p
      movedRef.current = false
      // Keep receiving moves even if the pointer leaves the picture mid-drag.
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    shotRef.current?.focus()
    // The next frame is up to a second away, so acknowledge the touch here.
    // Without this the mirror feels dead for the moment after a tap, however
    // fast the gesture actually reaches the device.
    const stage = stageRef.current
    if (stage && tappable) {
      const r = stage.getBoundingClientRect()
      setRipple({ x: e.clientX - r.left, y: e.clientY - r.top, id: Date.now() })
    }
  }

  /**
   * Move the device to wherever the pointer has got to, one segment at a time.
   *
   * baguette has no touch-down/move/up — only whole swipes — so a drag used to
   * be sent in one piece on release, and the screen sat still until you let go.
   * Sending a short swipe per step follows the finger instead. The next segment
   * waits for the previous one's ack, so this paces itself to whatever the
   * device can take rather than queueing up a backlog behind your hand.
   */
  const pumpDrag = useCallback(async (): Promise<void> => {
    if (draggingRef.current || !udid || !tappable) return
    draggingRef.current = true
    try {
      // Catch up to the pointer, one segment at a time. Looping rather than
      // recursing also means a finger lifted mid-flight still gets its last
      // segment sent: onUp records the final position and the next turn of the
      // loop carries the device there.
      for (;;) {
        const from = sentRef.current
        const to = latestRef.current
        if (!from || !to) break
        // Below a few points it is a tremor, not a drag.
        if (Math.hypot(to.x - from.x, to.y - from.y) < 6) break
        sentRef.current = { x: to.x, y: to.y }
        await window.cove.simInput(udid, {
          type: 'swipe',
          x: from.x,
          y: from.y,
          toX: to.x,
          toY: to.y,
          width: to.w,
          height: to.h,
          // A segment is one step of a drag, not a flick: baguette's 0.25s
          // default was spent entirely on lag behind the pointer.
          duration: DRAG_SEGMENT_SECONDS
        })
      }
    } finally {
      draggingRef.current = false
    }
  }, [udid, tappable])

  const onMove = (e: React.PointerEvent): void => {
    if (!dragRef.current) return
    const p = toDevice(e)
    if (!p) return
    latestRef.current = p
    const start = dragRef.current
    if (!movedRef.current && Math.hypot(p.x - start.x, p.y - start.y) > 12) movedRef.current = true
    if (movedRef.current) void pumpDrag()
  }

  const onUp = (e: React.PointerEvent): void => {
    const start = dragRef.current
    const p = toDevice(e)
    dragRef.current = null
    const dragged = movedRef.current
    movedRef.current = false
    if (!start || !p || !udid || !tappable) return
    const held = Date.now() - start.at
    if (dragged) {
      // Finish where the finger actually left off — the last segment may still
      // have been in flight when the pointer came up.
      latestRef.current = p
      void pumpDrag()
      return
    }
    void window.cove.simInput(udid, {
      type: 'tap',
      x: start.x,
      y: start.y,
      width: p.w,
      height: p.h,
      // A held press is how you get context menus and app wobble.
      ...(held > 500 ? { duration: Math.min(2, held / 1000) } : {})
    })
  }

  /**
   * Typing. Printable characters are buffered for a moment and sent as one
   * string — a round trip per keystroke would lag badly behind a fast typist —
   * while keys with meaning (Enter, Backspace, arrows) go straight through.
   */
  const flushTyping = useCallback((): void => {
    const { text } = typeBuf.current
    typeBuf.current = { text: '', timer: null }
    if (text && udid) void window.cove.simInput(udid, { type: 'text', text })
  }, [udid])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!udid || !tappable) return
    // Cmd/Ctrl+V pastes the Mac clipboard into the focused field on the device
    // — typed through as text, since the mirror has no real pasteboard bridge.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault()
      flushTyping()
      void navigator.clipboard.readText().then((text) => {
        if (text && udid) window.cove.simInput(udid, { type: 'text', text })
      })
      return
    }
    if (e.metaKey || e.ctrlKey) return // leave other app shortcuts alone
    const named: Record<string, string> = {
      Enter: 'Enter',
      Backspace: 'Backspace',
      Tab: 'Tab',
      Escape: 'Escape',
      ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft',
      ArrowRight: 'ArrowRight'
    }
    if (named[e.key]) {
      e.preventDefault()
      flushTyping()
      void window.cove.simInput(udid, { type: 'key', code: named[e.key] })
      return
    }
    if (e.key.length !== 1) return
    e.preventDefault()
    setTyping(true)
    typeBuf.current.text += e.key
    if (typeBuf.current.timer) clearTimeout(typeBuf.current.timer)
    typeBuf.current.timer = setTimeout(() => {
      flushTyping()
      setTyping(false)
    }, 160)
  }

  const choose = async (d: Device): Promise<void> => {
    setPicking(false)
    rememberDevice(d.udid)
    setUdid(d.udid)
    setFrame(null)
    if (d.state !== 'Booted') {
      setBusy(`Booting ${d.name}…`)
      await window.cove.simBoot(d.udid)
      setBusy(null)
    }
    await refresh()
  }

  /**
   * Shut a device down from the picker. If it was the one on screen, move to
   * another running one rather than sitting on a frozen last frame — and if
   * there is none, fall back to the empty state instead of the "stopped
   * responding" warning, which would be wrong for something you just did.
   */
  const shutdown = async (d: Device): Promise<void> => {
    // Shutting a device down takes a few seconds and used to look like nothing
    // had happened: the message went to the empty state, which a live picture
    // is covering, so the only clue was the picture eventually freezing.
    setShuttingDown(d.udid)
    setBusy(`Shutting down ${d.name}…`)
    const started = Date.now()
    await window.cove.simShutdown(d.udid)
    const list = await refresh()
    // A device that goes down in 300ms would otherwise flash the message too
    // briefly to read, which is indistinguishable from nothing happening.
    const shown = Date.now() - started
    if (shown < 700) await new Promise((r) => setTimeout(r, 700 - shown))
    setBusy(null)
    setShuttingDown(null)
    if (d.udid !== udid) return
    setGone(false)
    setFrame(null)
    const next = list.find((x) => x.state === 'Booted' && x.udid !== d.udid)
    setUdid(next?.udid ?? null)
    if (next) rememberDevice(next.udid)
    else {
      localStorage.removeItem(`cove.simDevice:${workspaceId}`)
      localStorage.removeItem('cove.simDevice')
      setPicking(true)
    }
  }

  const hardware = (button: string, title: string, glyph: string): React.JSX.Element => (
    <button
      className="sim-btn"
      title={title}
      disabled={!udid || !tappable}
      onClick={() => udid && void window.cove.simInput(udid, { type: 'press', button })}
    >
      {glyph}
    </button>
  )

  return (
    <div className="sim-pane">
      <div className="sim-toolbar">
        <button className="sim-device" onClick={() => setPicking((v) => !v)}>
          <span className={`sim-dot ${device?.state === 'Booted' ? 'on' : ''}`} />
          <span className="sim-device-name">{device ? device.name : 'Choose a simulator'}</span>
          <span className="sim-runtime">{device?.runtime ?? ''}</span>
          {/* Drawn, not typed: ⌄ (U+2304) sits high off the baseline and thins
              out at this size, which read as a stray mark rather than a menu. */}
          <svg
            className="sim-caret"
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4.5 6.5 8 10l3.5-3.5" />
          </svg>
        </button>
        {hardware('home', 'Home', '○')}
        {hardware('lock', 'Lock', '⏻')}
        {hardware('app-switcher', 'App switcher', '▤')}
        {typing && <span className="sim-typing">typing…</span>}
        {/* The escape hatch: Apple's own window, only when asked for. Until
            then it is kept out of sight, because a build opens it uninvited. */}
        <button
          className="sim-btn sim-open-app"
          title="Open this device in Apple's Simulator app"
          disabled={!udid}
          onClick={() => udid && void window.cove.simOpenApp?.(udid)}
        >
          ↗
        </button>
        {onClose && (
          <button className="sim-btn sim-close" title="Close the simulator" onClick={onClose}>
            ✕
          </button>
        )}
        {picking && (
          <>
            <div className="sim-scrim" onClick={() => setPicking(false)} />
            <div className="sim-menu">
              {devices.length === 0 && (
                <div className="sim-menu-empty">
                  No simulators found — install Xcode’s simulator runtimes.
                </div>
              )}
              {menuDevices.map((d) => (
                <div key={d.udid} className="sim-menu-row">
                  <button
                    className="sim-menu-item"
                    title={
                      d.state === 'Booted'
                        ? 'Mirror this simulator'
                        : `Boot ${d.name} and mirror it`
                    }
                    onClick={() => void choose(d)}
                  >
                    <span className={`sim-dot ${d.state === 'Booted' ? 'on' : ''}`} />
                    <span className="sim-menu-name">{d.name}</span>
                    <span className="sim-menu-rt">{d.runtime}</span>
                  </button>
                  {/* Shutting one down used to mean leaving for Simulator.app —
                      and a second booted device is what sends an app to a
                      screen nobody is watching. */}
                  {/* Sits over the runtime label rather than beside it: the
                      version keeps the right edge on every row, and hovering a
                      running device swaps it for the button in place, so
                      nothing shifts under the pointer. */}
                  {d.state === 'Booted' && (
                    <button
                      className={`sim-menu-off ${shuttingDown === d.udid ? 'working' : ''}`}
                      title={
                        shuttingDown === d.udid ? `Shutting down ${d.name}…` : `Shut down ${d.name}`
                      }
                      disabled={shuttingDown !== null}
                      onClick={(e) => {
                        e.stopPropagation()
                        void shutdown(d)
                      }}
                    >
                      {shuttingDown === d.udid ? <span className="sim-spinner" /> : '⏻'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="sim-stage" ref={stageRef}>
        {frame ? (
          <img
            ref={shotRef}
            className={`sim-screen ${tappable ? 'live' : ''}`}
            // Percentages, so the corner keeps its proportions at every size
            // the pane draws. The second value is the same physical radius
            // expressed against the height, which is what keeps it circular
            // rather than an ellipse on a tall screen.
            style={{
              borderRadius: (() => {
                const rx = cornerShareOfWidth(frame.width, frame.height) * 100
                if (!rx) return 0
                return `${rx.toFixed(2)}% / ${(rx * (frame.width / frame.height)).toFixed(2)}%`
              })()
            }}
            src={frame.url}
            alt={`${device?.name ?? 'iOS Simulator'} screen`}
            draggable={false}
            tabIndex={0}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKeyDown}
          />
        ) : (
          <div className="sim-empty">
            {busy ??
              (udid ? (
                'Waiting for the first frame…'
              ) : (
                // The picker is the only thing to do from here, so say it once
                // and make the words themselves open it.
                <button className="sim-note-link" onClick={() => setPicking(true)}>
                  Pick a simulator to mirror it here
                </button>
              ))}
          </div>
        )}
        {busy && frame && <div className="sim-status">{busy}</div>}
        {ripple && (
          <span
            key={ripple.id}
            className="sim-ripple"
            style={{ left: `${ripple.x}px`, top: `${ripple.y}px` }}
            onAnimationEnd={() => setRipple(null)}
          />
        )}
        {gone && frame && (
          <div className="sim-gone">
            <span>This simulator stopped responding.</span>
            <button
              className="sim-retry"
              onClick={() => {
                if (!udid) return
                setGone(false)
                void window.cove.simBoot(udid).then(async () => {
                  await refresh()
                  setReload((n) => n + 1)
                })
              }}
            >
              Boot it again
            </button>
          </div>
        )}
      </div>

      {!canInput && (
        <div className="sim-note">
          Tapping needs <code>brew install baguette</code> — the mirror works without it.{' '}
          <button
            className="sim-note-link"
            onClick={() => {
              window.cove.clipboardWrite('brew install baguette')
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {/* Floating tool dock beside the phone (the stage is centred, so this sits
          in the margin, not over the screen). Room to grow more tools later. */}
      {udid && (
        <div className="pane-dock corner">
          <button
            className="pane-dock-btn"
            title="Snip a region of the screen into your message"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('cove:start-snip', { detail: { workspaceId, source: 'sim' } })
              )
            }
          >
            <span className="pane-dock-icon">✂</span>
            <span>Snip</span>
          </button>
        </div>
      )}
    </div>
  )
}
