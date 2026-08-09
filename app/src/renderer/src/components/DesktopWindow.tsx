import { ReactNode, useCallback, useEffect, useRef } from 'react'

export interface WindowRect {
  x: number
  y: number
  w: number
  h: number
}

/** The eight places you can take hold of an edge, plus the title bar. */
type Grip = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 320
const MIN_H = 220
const TITLE_H = 34

/**
 * One window on the desktop: a title bar you drag it by, eight edges you resize
 * from, and traffic lights.
 *
 * Geometry lives with the desktop rather than in here, so a window survives
 * being closed and reopened, and the desktop can keep the stacking order
 * straight. This component only reports what the pointer did.
 *
 * Pointer capture does the work: once a drag starts, the events keep coming to
 * the same element even when the pointer outruns it, which is what stops a
 * window being dropped the moment you move faster than React re-renders.
 */
export function DesktopWindow({
  title,
  icon,
  rect,
  z,
  active,
  maximized,
  bounds,
  onChange,
  onFocus,
  onClose,
  onMinimize,
  onToggleMaximize,
  children
}: {
  title: string
  icon?: ReactNode
  rect: WindowRect
  z: number
  active: boolean
  maximized?: boolean
  /** The desktop's inner size, so a window cannot be dragged out of reach. */
  bounds: { w: number; h: number }
  onChange: (r: WindowRect) => void
  onFocus: () => void
  onClose: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  children: ReactNode
}): React.JSX.Element {
  const dragRef = useRef<{
    grip: Grip | 'move'
    startX: number
    startY: number
    from: WindowRect
  } | null>(null)
  const rectRef = useRef(rect)
  useEffect(() => {
    rectRef.current = rect
  })

  const onPointerMove = useCallback(
    (e: React.PointerEvent): void => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      const f = d.from
      let next: WindowRect

      if (d.grip === 'move') {
        next = { ...f, x: f.x + dx, y: f.y + dy }
      } else {
        let { x, y, w, h } = f
        if (d.grip.includes('e')) w = f.w + dx
        if (d.grip.includes('s')) h = f.h + dy
        if (d.grip.includes('w')) {
          // Dragging the left edge moves the origin as well as the width, and
          // must stop at the minimum rather than flipping the window inside out.
          const shrink = Math.min(dx, f.w - MIN_W)
          x = f.x + shrink
          w = f.w - shrink
        }
        if (d.grip.includes('n')) {
          const shrink = Math.min(dy, f.h - MIN_H)
          y = f.y + shrink
          h = f.h - shrink
        }
        next = { x, y, w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) }
      }

      // Keep it reachable: the title bar must stay on the desktop, so a window
      // can always be grabbed again.
      next.x = Math.min(Math.max(next.x, -next.w + 90), bounds.w - 90)
      next.y = Math.min(Math.max(next.y, 0), Math.max(0, bounds.h - TITLE_H))
      onChange(next)
    },
    [bounds.w, bounds.h, onChange]
  )

  const begin = useCallback(
    (grip: Grip | 'move') =>
      (e: React.PointerEvent): void => {
        if (e.button !== 0 || maximized) return
        e.preventDefault()
        e.stopPropagation()
        onFocus()
        dragRef.current = { grip, startX: e.clientX, startY: e.clientY, from: rectRef.current }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      },
    [maximized, onFocus]
  )

  const end = (e: React.PointerEvent): void => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const style: React.CSSProperties = maximized
    ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: z }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }

  return (
    <section
      className={`dw ${active ? 'active' : ''} ${maximized ? 'max' : ''}`}
      style={style}
      onPointerDown={onFocus}
      aria-label={title}
    >
      <header
        className="dw-bar"
        onPointerDown={begin('move')}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={onToggleMaximize}
      >
        <span className="dw-title">
          {icon}
          {title}
        </span>
        {/* Ours, not an imitation of the traffic lights: quiet monochrome
            glyphs on the right, where this app puts a ✕ everywhere else. */}
        <div className="dw-controls">
          <button
            className="dw-ctl"
            title="Minimise"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onMinimize}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 6h7" />
            </svg>
          </button>
          <button
            className="dw-ctl"
            title={maximized ? 'Restore' : 'Fill the desktop'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onToggleMaximize}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              {maximized ? (
                <path d="M2.5 5.2h4.3v4.3H2.5zM5.2 5.2V2.5h4.3v4.3H6.8" />
              ) : (
                <rect x="2.5" y="2.5" width="7" height="7" rx="1.2" />
              )}
            </svg>
          </button>
          <button
            className="dw-ctl dw-ctl-close"
            title="Close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
      </header>

      <div className="dw-body">{children}</div>

      {/* Eight grips. Hidden while maximised — there is nothing to resize into. */}
      {!maximized &&
        (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Grip[]).map((g) => (
          <span
            key={g}
            className={`dw-grip dw-grip-${g}`}
            onPointerDown={begin(g)}
            onPointerMove={onPointerMove}
            onPointerUp={end}
            onPointerCancel={end}
          />
        ))}
    </section>
  )
}
