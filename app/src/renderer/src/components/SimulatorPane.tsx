import { useEffect, useRef, useState } from 'react'

interface Device {
  udid: string
  name: string
  state: string
  runtime: string
}

/**
 * A live iOS Simulator inside the app, beside the chat.
 *
 * Frames come from simctl screenshots (about 1.6/s) rather than a video
 * stream — see src/main/simulator.ts for why. Taps and swipes go through
 * baguette and force an immediate frame, so touching the picture feels
 * connected even though the refresh is slow between actions.
 */
export function SimulatorPane({ visible = true }: { visible?: boolean }): React.JSX.Element {
  const [devices, setDevices] = useState<Device[]>([])
  const [udid, setUdid] = useState<string | null>(null)
  const [frame, setFrame] = useState<{ url: string; width: number; height: number } | null>(null)
  const [booting, setBooting] = useState(false)
  const [canInput, setCanInput] = useState(true)
  const [picking, setPicking] = useState(false)
  const shotRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ x: number; y: number; t: number } | null>(null)

  useEffect(() => {
    void window.cove.simList().then((list) => {
      setDevices(list)
      // Land on whatever is already booted; otherwise wait for a choice.
      const booted = list.find((d) => d.state === 'Booted')
      if (booted) setUdid(booted.udid)
      else setPicking(true)
    })
    void window.cove.simHasInput().then(setCanInput)
  }, [])

  // Frames only while this pane is actually on screen — a background stream
  // would keep shelling out to simctl for a picture nobody sees.
  useEffect(() => {
    if (!udid || !visible) return
    const off = window.cove.onSimFrame(udid, setFrame)
    window.cove.simStreamStart(udid, 2)
    return () => {
      window.cove.simStreamStop(udid)
      off()
    }
  }, [udid, visible])

  const device = devices.find((d) => d.udid === udid)
  // Gestures are injected by baguette, which targets iOS 26 and up: on older
  // runtimes a tap reports success and quietly does nothing (measured — the
  // same tap opens an app on iOS 26.5 and no-ops on 18.6). Say so, rather than
  // letting the picture look broken.
  const major = Number(/iOS[ -](\d+)/i.exec(device?.runtime ?? '')?.[1] ?? 0)
  const tappable = canInput && (major === 0 || major >= 26)

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
    if (p) dragRef.current = { x: p.x, y: p.y, t: Date.now() }
  }

  const onUp = (e: React.PointerEvent): void => {
    const start = dragRef.current
    const p = toDevice(e)
    dragRef.current = null
    if (!start || !p || !udid) return
    const far = Math.hypot(p.x - start.x, p.y - start.y) > 24
    void window.cove.simInput(
      udid,
      far
        ? { type: 'swipe', x: start.x, y: start.y, toX: p.x, toY: p.y, width: p.w, height: p.h }
        : { type: 'tap', x: start.x, y: start.y, width: p.w, height: p.h }
    )
  }

  const boot = async (id: string): Promise<void> => {
    setBooting(true)
    setUdid(id)
    setPicking(false)
    await window.cove.simBoot(id)
    setBooting(false)
    setDevices(await window.cove.simList())
  }

  return (
    <div className="sim-pane">
      <div className="sim-toolbar">
        <button className="sim-device" onClick={() => setPicking((v) => !v)}>
          {device ? device.name : 'Choose a simulator'}
          <span className="sim-runtime">{device?.runtime ?? ''}</span>
        </button>
        {udid && (
          <>
            <button
              className="sim-btn"
              title="Home"
              onClick={() => void window.cove.simInput(udid, { type: 'press', button: 'home' })}
            >
              ○
            </button>
            <button
              className="sim-btn"
              title="Lock"
              onClick={() => void window.cove.simInput(udid, { type: 'press', button: 'lock' })}
            >
              ⏻
            </button>
          </>
        )}
        {picking && (
          <div className="sim-menu">
            {devices.length === 0 && <div className="sim-menu-empty">No simulators found.</div>}
            {devices.map((d) => (
              <button key={d.udid} className="sim-menu-item" onClick={() => void boot(d.udid)}>
                <span className={`sim-dot ${d.state === 'Booted' ? 'on' : ''}`} />
                <span className="sim-menu-name">{d.name}</span>
                <span className="sim-menu-rt">{d.runtime}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sim-stage">
        {frame ? (
          <img
            ref={shotRef}
            className="sim-screen"
            src={frame.url}
            alt="iOS Simulator"
            draggable={false}
            onPointerDown={onDown}
            onPointerUp={onUp}
          />
        ) : (
          <div className="sim-empty">
            {booting
              ? 'Booting the simulator…'
              : udid
                ? 'Waiting for the first frame…'
                : 'Pick a simulator to mirror it here.'}
          </div>
        )}
      </div>

      {!canInput && (
        <div className="sim-note">
          Tapping needs <code>brew install baguette</code> — the picture works without it.
        </div>
      )}
      {canInput && !tappable && (
        <div className="sim-note">
          This runtime is {device?.runtime} — tapping needs an iOS 26 or newer simulator. The
          mirror works either way.
        </div>
      )}
    </div>
  )
}
