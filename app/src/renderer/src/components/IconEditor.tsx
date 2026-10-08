import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayLock } from '../state'
import { drawAppIcon, ICON_BOX, pictureRect, clampPlace, type IconPlace } from '../app-icon'

const VIEW = 260

/**
 * Placing your own picture in the app icon: what the icon will look like, drawn
 * live, with the picture dragged into place and zoomed. Picking a file used to
 * change the Dock icon at once, cropped to its centre, with nothing to adjust
 * and nothing in Settings to show for it.
 */
export function IconEditor({
  image,
  initial,
  onUse,
  onCancel,
  onAnother
}: {
  image: HTMLImageElement
  initial: IconPlace
  onUse: (place: IconPlace) => void
  onCancel: () => void
  onAnother: () => void
}): React.JSX.Element {
  useOverlayLock()
  const [place, setPlace] = useState<IconPlace>(initial)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number; from: IconPlace } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = VIEW * dpr
    canvas.height = VIEW * dpr
    drawAppIcon(ctx, VIEW * dpr, image, place)
  }, [image, place])

  // Dragging moves the picture under the icon: by pixels on screen, turned
  // back into the fraction of the room there is to slide.
  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const r = pictureRect(image.width, image.height, VIEW, VIEW * ICON_BOX, d.from)
    setPlace(
      clampPlace({
        zoom: d.from.zoom,
        x: r.panX > 0.5 ? d.from.x + (e.clientX - d.x) / r.panX : 0,
        y: r.panY > 0.5 ? d.from.y + (e.clientY - d.y) / r.panY : 0
      })
    )
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="new-project icon-editor"
        role="dialog"
        aria-label="Place your picture in the icon"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter') onUse(place)
        }}
      >
        <h2 className="new-project-title">App icon</h2>
        <p className="new-project-sub">Drag the picture into place, and zoom to fit.</p>
        <canvas
          ref={canvasRef}
          className="icon-editor-canvas"
          style={{ width: VIEW, height: VIEW }}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, from: place }
          }}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) =>
            setPlace((p) => clampPlace({ ...p, zoom: p.zoom * (e.deltaY < 0 ? 1.04 : 1 / 1.04) }))
          }
        />
        <label className="icon-editor-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={5}
            step={0.01}
            value={place.zoom}
            autoFocus
            aria-label="Zoom"
            onChange={(e) => setPlace((p) => clampPlace({ ...p, zoom: Number(e.target.value) }))}
          />
        </label>
        <div className="signins-actions icon-editor-actions">
          <button className="signins-cancel icon-editor-another" onClick={onAnother}>
            Choose another…
          </button>
          <span className="icon-editor-gap" />
          <button className="signins-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="signins-primary" onClick={() => onUse(place)}>
            Use this icon
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
