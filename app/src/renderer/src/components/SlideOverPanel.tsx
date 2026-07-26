import { ReactNode } from 'react'
import { useOverlayLock } from '../state'

interface SlideOverPanelProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** 'side' slides in from the right (Skills/Routines); 'center' is a centered modal (Settings). */
  variant?: 'side' | 'center'
}

/** Shared overlay + header shell for the slide-out panels. */
export function SlideOverPanel({
  title,
  onClose,
  children,
  variant = 'side'
}: SlideOverPanelProps): React.JSX.Element {
  // Hide the native browser view while this panel is open (it would cover it).
  useOverlayLock()
  return (
    <div className="skills-overlay" onClick={onClose}>
      <div
        className={variant === 'center' ? 'settings-panel' : 'skills-panel'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="skills-header">
          <span>{title}</span>
          <button className="skills-close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
