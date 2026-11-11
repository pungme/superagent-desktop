import { useEffect, useRef, useState } from 'react'
import type { SavedPrompt } from '../lib/saved-prompts'

/**
 * Above the message box: "2 saved", and the prompts set aside with ⌘S. Each can
 * go back in the box (what is there now is set aside in its place), be sent as
 * it is, or be thrown away.
 */
export function SavedPromptsBar({
  saved,
  onUse,
  onSend,
  onRemove
}: {
  saved: SavedPrompt[]
  onUse: (p: SavedPrompt) => void
  onSend: (p: SavedPrompt) => void
  onRemove: (p: SavedPrompt) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  if (!saved.length) return null
  return (
    <div className="saved-prompts" ref={ref}>
      <button
        className={`saved-chip ${open ? 'on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Prompts you set aside with ⌘S"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 2.5h7a1 1 0 0 1 1 1v10l-4.5-3-4.5 3v-10a1 1 0 0 1 1-1z" />
        </svg>
        {saved.length} saved
      </button>
      {open && (
        <div className="saved-menu" role="menu">
          {saved.map((p) => (
            <div key={p.id} className="saved-item" role="menuitem">
              <button
                className="saved-text"
                title="Put it back in the message box"
                onClick={() => {
                  setOpen(false)
                  onUse(p)
                }}
              >
                {p.text}
              </button>
              <div className="saved-actions">
                <button
                  onClick={() => {
                    setOpen(false)
                    onUse(p)
                  }}
                >
                  Use
                </button>
                <button
                  onClick={() => {
                    setOpen(false)
                    onSend(p)
                  }}
                >
                  Send
                </button>
                <button
                  className="saved-remove"
                  aria-label="Remove"
                  title="Remove"
                  onClick={() => onRemove(p)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
          <div className="saved-hint">⌘S in the message box sets what you are writing aside.</div>
        </div>
      )}
    </div>
  )
}
