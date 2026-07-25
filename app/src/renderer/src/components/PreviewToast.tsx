import { useEffect } from 'react'
import { useStore } from '../state'

export function PreviewToast(): React.JSX.Element | null {
  const toast = useStore((s) => s.toast)
  const openPreview = useStore((s) => s.openPreview)
  const dismissToast = useStore((s) => s.dismissToast)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dismissToast, 8000)
    return () => clearTimeout(t)
  }, [toast, dismissToast])

  if (!toast) return null

  return (
    <div className="preview-toast">
      <span className="preview-toast-dot" />
      <span>Dev server detected on :{toast.port}</span>
      <button
        className="preview-toast-open"
        onClick={() => openPreview(toast.workspaceId, toast.port)}
      >
        Open preview
      </button>
      <button className="preview-toast-close" onClick={dismissToast} title="Dismiss">
        ×
      </button>
    </div>
  )
}
