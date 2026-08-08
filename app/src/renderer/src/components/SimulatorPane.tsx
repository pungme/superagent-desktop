import { useCallback, useEffect, useRef, useState } from 'react'

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

type Mode = 'mirror' | 'attach'

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
export function SimulatorPane({ visible = true }: { visible?: boolean }): React.JSX.Element {
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
  const [picking, setPicking] = useState(false)
  const [typing, setTyping] = useState(false)
  /**
   * 'attach' parks Apple's own Simulator window over this pane: nothing is
   * streamed, so it is the real device at native speed. 'mirror' streams
   * frames and works with no permissions. Remembered, because whichever one
   * suits your machine suits it every time.
   */
  const [mode, setMode] = useState<Mode>(() =>
    localStorage.getItem('cove.simMode') === 'attach' ? 'attach' : 'mirror'
  )
  const [attachError, setAttachError] = useState<string | null>(null)
  /** Where the last touch landed, in % of the picture — drawn immediately. */
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const shotRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const typeBuf = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({
    text: '',
    timer: null
  })

  const device = devices.find((d) => d.udid === udid)

  /**
   * Booted first, then alphabetical. simctl lists by runtime, so the device you
   * are actually running would otherwise sit somewhere down a list of dozens.
   */
  const menuDevices = [...devices].sort(
    (a, b) =>
      Number(b.state === 'Booted') - Number(a.state === 'Booted') || a.name.localeCompare(b.name)
  )

  const refresh = useCallback(async (): Promise<Device[]> => {
    const list = await window.cove.simList()
    setDevices(list)
    return list
  }, [])

  useEffect(() => {
    void refresh().then((list) => {
      // Whatever is already booted — every runtime can be tapped.
      const booted = list.filter((d) => d.state === 'Booted')
      // Whichever one you picked last, if it's still running — otherwise the
      // pane silently swaps devices under you on every restart.
      const remembered = localStorage.getItem('cove.simDevice')
      const best = booted.find((d) => d.udid === remembered) ?? booted[0]
      if (best) setUdid(best.udid)
      else setPicking(true)
    })
    void window.cove.simHasInput().then(setCanInput)
  }, [refresh])

  // Frames only while this pane is on screen — a background stream would keep
  // shelling out to simctl for a picture nobody is looking at.
  useEffect(() => {
    if (!udid || !visible || mode !== 'mirror') return
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
  }, [udid, visible, mode, reload])

  /**
   * Keep the real Simulator window sitting exactly on this pane. There is no
   * DOM event for the app window being dragged, so the rectangle is re-sent on
   * a slow tick — cheap, and it means the device never drifts off the pane.
   */
  useEffect(() => {
    if (mode !== 'attach' || !udid) return
    let alive = true
    let last = ''
    const rectNow = (): { x: number; y: number; width: number; height: number } | null => {
      const el = stageRef.current
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width < 40 || r.height < 40) return null
      return {
        x: Math.round(window.screenX + r.left),
        y: Math.round(window.screenY + r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }
    }
    const first = rectNow()
    if (first) {
      void window.cove.simAttach(udid, first).then((res) => {
        if (!alive) return
        setAttachError(res.ok ? null : (res.error ?? 'failed'))
      })
    }
    const iv = setInterval(() => {
      if (!visible) return
      const r = rectNow()
      if (!r) return
      const key = `${r.x},${r.y},${r.width},${r.height}`
      if (key === last) return
      last = key
      void window.cove.simAttachMove(r)
    }, 400)
    return () => {
      alive = false
      clearInterval(iv)
      void window.cove.simAttachHide()
    }
  }, [mode, udid, visible])

  /**
   * The attached window is pinned on top so that clicking back into the chat
   * doesn't send the device behind us. That pin has to be undone the moment
   * SuperAgent isn't frontmost, or the simulator would float over whatever the
   * user switched to — so hide it on blur and bring it back on focus.
   */
  useEffect(() => {
    if (mode !== 'attach' || !udid) return
    if (!visible) {
      void window.cove.simAttachHide()
      return
    }
    return window.cove.onAppFocus?.((focused) => {
      if (focused) void window.cove.simAttachShow()
      else void window.cove.simAttachHide()
    })
  }, [mode, visible, udid])

  // Anything baguette can drive is tappable. There used to be an iOS 26+ gate
  // here, on the belief that older runtimes silently ignored input — measured
  // against 18.6 and that is simply not true: taps land and the screen reacts.
  // The gate was disabling a working feature on every older simulator.
  const tappable = canInput

  /** Rendered position → device points, which is what the injector expects. */
  const toDevice = (e: React.PointerEvent): { x: number; y: number; w: number; h: number } | null => {
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
    if (p) dragRef.current = { x: p.x, y: p.y, at: Date.now() }
    shotRef.current?.focus()
    // The next frame is up to a second away, so acknowledge the touch here.
    // Without this the mirror feels dead for the moment after a tap, however
    // fast the gesture actually reaches the device.
    const box = shotRef.current
    if (box && tappable) {
      const r = box.getBoundingClientRect()
      setRipple({
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
        id: Date.now()
      })
    }
  }

  const onUp = (e: React.PointerEvent): void => {
    const start = dragRef.current
    const p = toDevice(e)
    dragRef.current = null
    if (!start || !p || !udid || !tappable) return
    const moved = Math.hypot(p.x - start.x, p.y - start.y)
    const held = Date.now() - start.at
    void window.cove.simInput(
      udid,
      moved > 24
        ? { type: 'swipe', x: start.x, y: start.y, toX: p.x, toY: p.y, width: p.w, height: p.h }
        : {
            type: 'tap',
            x: start.x,
            y: start.y,
            width: p.w,
            height: p.h,
            // A held press is how you get context menus and app wobble.
            ...(held > 500 ? { duration: Math.min(2, held / 1000) } : {})
          }
    )
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
    if (e.metaKey || e.ctrlKey) return // leave app shortcuts alone
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
    localStorage.setItem('cove.simDevice', d.udid)
    setUdid(d.udid)
    setFrame(null)
    if (d.state !== 'Booted') {
      setBusy(`Booting ${d.name}…`)
      await window.cove.simBoot(d.udid)
      setBusy(null)
    }
    await refresh()
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
          {device ? device.name : 'Choose a simulator'}
          <span className="sim-runtime">{device?.runtime ?? ''}</span>
          <span className="sim-caret">⌄</span>
        </button>
        {hardware('home', 'Home', '○')}
        {hardware('lock', 'Lock', '⏻')}
        {hardware('app-switcher', 'App switcher', '▤')}
        {typing && <span className="sim-typing">typing…</span>}
        <div className="sim-mode">
          <button
            className={`sim-mode-btn ${mode === 'mirror' ? 'on' : ''}`}
            onClick={() => {
              localStorage.setItem('cove.simMode', 'mirror')
              setMode('mirror')
            }}
            title="Show the device here, streamed into the pane"
          >
            In the app
          </button>
          <button
            className={`sim-mode-btn ${mode === 'attach' ? 'on' : ''}`}
            onClick={async () => {
              const { trusted } = await window.cove.simAttachReady()
              if (!trusted) await window.cove.simAttachRequest()
              localStorage.setItem('cove.simMode', 'attach')
              setAttachError(null)
              setMode('attach')
            }}
            title="Put the real Simulator window here — native speed, real touch"
          >
            Real device
          </button>
        </div>
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
                <button
                  key={d.udid}
                  className="sim-menu-item"
                  title={d.state === 'Booted' ? 'Mirror this simulator' : `Boot ${d.name} and mirror it`}
                  onClick={() => void choose(d)}
                >
                  <span className={`sim-dot ${d.state === 'Booted' ? 'on' : ''}`} />
                  <span className="sim-menu-name">{d.name}</span>
                  <span className="sim-menu-rt">
                    {d.runtime}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="sim-stage" ref={stageRef}>
        {mode === 'attach' ? (
          attachError ? (
            <div className="sim-attach-msg">
              {attachError === 'no-accessibility' ? (
                <>
                  <p>
                    Parking the real Simulator here needs Accessibility permission — the same one
                    window managers ask for.
                  </p>
                  <button className="sim-retry" onClick={() => void window.cove.simAttachSettings()}>
                    Open System Settings
                  </button>
                </>
              ) : (
                <>
                  <p>Couldn’t place the Simulator window ({attachError}).</p>
                  <button className="sim-retry" onClick={() => setMode('mirror')}>
                    Use the mirror instead
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="sim-attach-msg subtle">
              The real Simulator is parked here — tap it like a device.
            </div>
          )
        ) : frame ? (
          <img
            ref={shotRef}
            className={`sim-screen ${tappable ? 'live' : ''}`}
            src={frame.url}
            alt={`${device?.name ?? 'iOS Simulator'} screen`}
            draggable={false}
            tabIndex={0}
            onPointerDown={onDown}
            onPointerUp={onUp}
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
        {mode !== 'attach' && ripple && (
          <span
            key={ripple.id}
            className="sim-ripple"
            style={{ left: `${ripple.x}%`, top: `${ripple.y}%` }}
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
              void navigator.clipboard.writeText('brew install baguette')
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}
