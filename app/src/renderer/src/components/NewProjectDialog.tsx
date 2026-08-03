import { useEffect } from 'react'
import { useStore, useOverlayLock } from '../state'

export function NewProjectDialog(): React.JSX.Element | null {
  const groupId = useStore((s) => s.newProjectGroupId)
  const close = useStore((s) => s.closeNewProject)
  const createCode = useStore((s) => s.createCodeProject)
  const createBrowser = useStore((s) => s.createBrowserProject)
  // Hide the native browser view while the dialog is open (only when shown).
  useOverlayLock(!!groupId)

  useEffect(() => {
    if (!groupId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [groupId, close])

  if (!groupId) return null

  return (
    <div className="dialog-backdrop" onClick={close}>
      <div className="new-project" onClick={(e) => e.stopPropagation()}>
        <h2 className="new-project-title">New project</h2>
        <p className="new-project-sub">What are you working on?</p>
        <div className="new-project-options">
          <button className="new-project-card" onClick={() => createCode(groupId)}>
            <span className="new-project-icon">📁</span>
            <span className="new-project-card-title">Folder</span>
            <span className="new-project-card-desc">
              Open any folder — code, docs, anything. Claude gets the file tree, terminal, and live
              preview to work on what's inside.
            </span>
          </button>
          <button className="new-project-card" onClick={() => createBrowser(groupId)}>
            <span className="new-project-icon">🌐</span>
            <span className="new-project-card-title">Browser</span>
            <span className="new-project-card-desc">
              No folder needed. Open the browser and have Claude automate it — e.g. “visit this site
              every hour and follow 5 people”.
            </span>
          </button>
        </div>
        <button className="new-project-cancel" onClick={close}>
          Cancel
        </button>
      </div>
    </div>
  )
}
