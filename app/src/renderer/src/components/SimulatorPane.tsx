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

/** iOS major from a runtime label like "iOS 26 5"; 0 when it can't be read. */
function iosMajor(runtime: string): number {
  return Number(/iOS[ -](\d+)/i.exec(runtime)?.[1] ?? 0)
}

/**
 * A live iOS Simulator inside the app, beside the chat.
 *
 * Frames come from simctl screenshots — see src/main/simulator.ts for why the
 * video stream isn't used — and gestures go through baguette, which forces an
 * immediate grab so the picture answers a touch straight away.
 */
export function SimulatorPane({ visible = true }: { visible?: boolean }): React.JSX.Element {
  const [devices, setDevices] = useState<Device[]>([])
  const [udid, setUdid] = useState<string | null>(null)
  const [frame, setFrame] = useState<Frame | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [canInput, setCanInput] = useState(true)
  const [picking, setPicking] = useState(false)
  const [typing, setTyping] = useState(false)
  /**
   * 'attach' parks Apple's own Simulator window over this pane: nothing is
   * streamed, so it is the real device at native speed. 'mirror' streams
   * frames and works with no permissions. Remembered, because whichever one
   * suits your machine suits it every time.
   */
  const [mode, setMode] = useState<'mirror' | 'attach'>(
    () => (localStorage.getItem('cove.simMode') as 'mirror' | 'attach') || 'mirror'
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

  const refresh = useCallback(async (): Promise<Device[]> => {
    const list = await window.cove.simList()
    setDevices(list)
    return list
  }, [])

  useEffect(() => {
    void refresh().then((list) => {
      // Prefer something already booted that can also be tapped — landing on an
      // old runtime means a mirror that ignores every touch.
      const booted = list.filter((d) => d.state === 'Booted')
      const best = booted.find((d) => iosMajor(d.runtime) >= 26) ?? booted[0]
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
  }, [udid, visible, mode])

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

  const device = devices.find((d) => d.udid === udid)
  // Gestures are injected by baguette, which targets iOS 26 and up: on older
  // runtimes a tap reports success and quietly does nothing (measured — the
  // same tap opens an app on 26.5 and no-ops on 18.6).
  const tappable = canInput && (!device || iosMajor(device.runtime) >= 26)

  /** Rendered position → device points, which is what the injector expects. */
  const toDevice = (e: React.PointerEvent): { x: number; y: number; w: number; h: number } | null => {
    const img = shotRef.current
    if (!img || !frame) return null
    const r = img.getBoundingClientRect()
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * frame.width),
      y: Math.round(((e.clientY - r.top) / r.height) * frame.height),
      w: frame.width,
      h: frame.height
    }
  }

  const onDown = (e: React.PointerEvent): void => {
    const p = toDevice(e)
    if (p) dragRef.current = { x: p.x, y: p.y, at: Date.now() }
    shotRef.current?.focus()
    // The next frame is up to a second away, so acknowledge the touch here.
    // Without this the mirror feels dead for the moment after a tap, however
    // fast the gesture actually reaches the device.
    const img = shotRef.current
    if (img && tappable) {
      const r = img.getBoundingClientRect()
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
            title="Stream frames into the pane — works anywhere, no permissions"
          >
            Mirror
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
              {devices.map((d) => (
                <button key={d.udid} className="sim-menu-item" onClick={() => void choose(d)}>
                  <span className={`sim-dot ${d.state === 'Booted' ? 'on' : ''}`} />
                  <span className="sim-menu-name">{d.name}</span>
                  <span className="sim-menu-rt">
                    {d.runtime}
                    {iosMajor(d.runtime) < 26 && iosMajor(d.runtime) > 0 && (
                      <span className="sim-menu-warn" title="Tapping needs iOS 26 or newer">
                        {' '}
                        view only
                      </span>
                    )}
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
            {busy ?? (udid ? 'Waiting for the first frame…' : 'Pick a simulator to mirror it here.')}
          </div>
        )}
        {mode === 'mirror' && ripple && (
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
                void window.cove.simBoot(udid).then(refresh)
              }}
            >
              Boot it again
            </button>
          </div>
        )}
      </div>

      {!canInput && (
        <div className="sim-note">
          Tapping needs <code>brew install baguette</code> — the mirror works without it.
        </div>
      )}
      {canInput && device && iosMajor(device.runtime) > 0 && iosMajor(device.runtime) < 26 && (
        <div className="sim-note">
          {device.runtime} mirrors fine, but tapping needs an iOS 26 or newer simulator.
        </div>
      )}
    </div>
  )
}
