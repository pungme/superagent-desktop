import { useEffect, useState } from 'react'
import { idleFor } from '../lib/idle-for'

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
/**
 * Icons, kept. A row used to start blank every time it mounted (a project
 * folded open, a window reloaded, the sidebar re-rendered) and wait for the
 * main process to read the icon off disk again — so icons blinked out and back.
 * The last one seen is drawn at once, from memory, or from localStorage on a
 * fresh start; the refresh still runs, behind it.
 */
const memory = new Map<string, ProjectIconState>()
const STORE = 'cove.projectIcon:'
/** Big enough for an app icon; anything larger is not worth a storage slot. */
const MAX_STORED = 200_000

function remembered(key: string): ProjectIconState | undefined {
  if (memory.has(key)) return memory.get(key)
  try {
    const raw = localStorage.getItem(STORE + key)
    if (!raw) return undefined
    const icon = JSON.parse(raw) as ProjectIconState
    memory.set(key, icon)
    return icon
  } catch {
    return undefined
  }
}

function remember(key: string, icon: ProjectIconState): void {
  memory.set(key, icon)
  try {
    const raw = JSON.stringify(icon)
    if (raw.length <= MAX_STORED) localStorage.setItem(STORE + key, raw)
  } catch {
    /* storage full: memory still has it for this session */
  }
}

export function useProjectIcon(workspaceId: string, path: string, kind: string): ProjectIconState {
  const key = `${workspaceId}|${path}`
  const [icon, setIcon] = useState<ProjectIconState>(() =>
    kind === 'app' ? (remembered(key) ?? null) : null
  )
  const [seenKind, setSeenKind] = useState(kind)
  if (seenKind !== kind) {
    setSeenKind(kind)
    if (kind !== 'app') setIcon(null)
  }
  useEffect(() => {
    if (kind !== 'app') return
    let alive = true
    const refresh = (): void => {
      window.cove
        .projectIcon(workspaceId, path)
        .then((d) => {
          remember(key, d)
          if (alive) setIcon(d)
        })
        // A failed read keeps the icon that was there rather than blanking it.
        .catch(() => {})
    }
    refresh()
    const onIdle = idleFor(workspaceId, refresh)
    window.addEventListener('cove:workspace-idle', onIdle)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', onIdle)
    }
  }, [workspaceId, path, kind, key])
  return icon
}
