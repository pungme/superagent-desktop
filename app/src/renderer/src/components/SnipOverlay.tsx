import { useEffect, useRef, useState } from 'react'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Snip a region out of a frozen still of the pane. The pane is a native view
 * that paints above HTML, so we can't draw a selection box on the live view —
 * the caller hands us a captured still (browser freeze-frame or a simulator
 * screenshot) and we let the user drag a rectangle over THAT, then crop it.
 */
export function SnipOverlay({
  still,
  onCapture,
  onCancel
}: {
  still: string
  onCapture: (dataUrl: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const rel = (e: React.PointerEvent): { x: number; y: number } => {
    const box = frameRef.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(e.clientX - box.left, box.width)),
      y: Math.max(0, Math.min(e.clientY - box.top, box.height))
    }
  }

  const down = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = rel(e)
    startRef.current = p
    setRect({ x: p.x, y: p.y, w: 0, h: 0 })
  }
  const move = (e: React.PointerEvent): void => {
    const s = startRef.current
    if (!s) return
    const p = rel(e)
    setRect({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y)
    })
  }
  const up = (): void => {
    const s = startRef.current
    startRef.current = null
    // A too-small box is a mis-click, not a selection — ignore it.
    if (!s || !rect || rect.w < 6 || rect.h < 6) {
      setRect(null)
      return
    }
    const img = imgRef.current!
    const sx = img.naturalWidth / img.clientWidth
    const sy = img.naturalHeight / img.clientHeight
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(rect.w * sx))
    canvas.height = Math.max(1, Math.round(rect.h * sy))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(
      img,
      rect.x * sx,
      rect.y * sy,
      rect.w * sx,
      rect.h * sy,
      0,
      0,
      canvas.width,
      canvas.height
    )
    onCapture(canvas.toDataURL('image/png'))
  }

  return (
    <div
      className="snip-overlay"
      // Click the dimmed area outside the still to cancel.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="snip-frame"
        ref={frameRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
      >
        <img className="snip-still" ref={imgRef} src={still} alt="" draggable={false} />
        {rect && (
          <div
            className="snip-rect"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          />
        )}
      </div>
      <div className="snip-hint">Drag to snip — Esc to cancel</div>
    </div>
  )
}
