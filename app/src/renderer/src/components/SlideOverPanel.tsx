import { ReactNode } from 'react'

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
