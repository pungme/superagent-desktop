import { ReactNode } from 'react'
import { useEscapeClose } from '../hooks/useEscapeClose'

/**
 * A full-window section, the way Computer and Dashboard are: it takes the
 * whole content area rather than sliding in over a project.
 *
 * Skills and Routines used to arrive as slide-overs from the right, which made
 * them feel like a dialog belonging to whatever project was underneath — when
 * they are places you go, the same as the other two.
 */
export function SectionView({
  title,
  onClose,
  children,
  embedded = false
}: {
  title: string
  onClose: () => void
  children: ReactNode
  /** Inside a desktop window, which supplies its own title bar and close. */
  embedded?: boolean
}): React.JSX.Element {
  // The window owns Escape when embedded — closing the app from in here would
  // leave its frame standing empty.
  useEscapeClose(onClose, !embedded)
  if (embedded) return <div className="section-body section-embedded">{children}</div>
  return (
    <div className="section-view">
      <div className="section-head">
        <h2>{title}</h2>
        <button className="dash-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="section-body">{children}</div>
    </div>
  )
}
