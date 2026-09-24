import { useEffect, useState } from 'react'

export type ProjectIconState =
  | { source: 'app-icon' | 'favicon' | 'custom'; dataUri: string }
  | { source: 'kind'; kind: string }
  | null

/** What a code/app project actually IS, read off its own files — a manual
 *  override if one was set, else a website's favicon, a native app's own app
 *  icon, or a symbolic glyph for a non-dev project (screenplay, design,
 *  music, documents). Re-fetched on 'cove:workspace-idle' so "Change icon…"
 *  and "Use detected icon" show up without a full reload. Browser-kind
 *  projects use their own live-page favicon instead (see WorkspaceRow). */
export function useProjectIcon(workspaceId: string, path: string, kind: string): ProjectIconState {
  const [icon, setIcon] = useState<ProjectIconState>(null)
  const [seenKind, setSeenKind] = useState(kind)
  if (seenKind !== kind) {
    setSeenKind(kind)
    if (kind !== 'app') setIcon(null)
  }
  useEffect(() => {
    if (kind !== 'app') return
    let alive = true
    const refresh = (): void => {
      window.cove.projectIcon(workspaceId, path).then((d) => {
        if (alive) setIcon(d)
      })
    }
    refresh()
    window.addEventListener('cove:workspace-idle', refresh)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', refresh)
    }
  }, [workspaceId, path, kind])
  return icon
}
