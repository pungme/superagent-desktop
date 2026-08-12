import { ipcMain } from 'electron'

/**
 * What is on the Computer desktop, as the main process knows it.
 *
 * The desktop is a renderer thing — windows, their geometry, the files dropped
 * on it, the browser's tabs all live in React state. But the desktop chat's
 * agent runs out here, and it cannot help with a computer it cannot see. So the
 * renderer reports a small snapshot whenever any of it changes, and the
 * computer_* MCP tools read from this.
 *
 * It is deliberately a mirror, not a source of truth: nothing here is
 * persisted, and a stale snapshot costs the agent a slightly out-of-date
 * answer rather than the desktop a wrong window.
 */

export interface DesktopWindowInfo {
  app: string
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  maximized: boolean
  /** The frontmost window — the one the user is looking at. */
  focused: boolean
}

export interface DesktopTabInfo {
  id: string
  url: string
  active: boolean
}

export interface DesktopSnapshot {
  windows: DesktopWindowInfo[]
  files: { name: string; path: string }[]
  tabs: DesktopTabInfo[]
  /** The desktop's own size, so an agent can arrange windows sensibly. */
  bounds: { w: number; h: number }
  /** False while the Computer is closed — then nothing on it is on screen. */
  open: boolean
}

const empty: DesktopSnapshot = {
  windows: [],
  files: [],
  tabs: [],
  bounds: { w: 0, h: 0 },
  open: false
}

let snapshot: DesktopSnapshot = { ...empty }

export function desktopState(): DesktopSnapshot {
  return snapshot
}

/** The pane id of the browser tab in front, if the Browser app is open. */
export function activeDesktopTab(): string | null {
  return snapshot.tabs.find((t) => t.active)?.id ?? null
}

export function registerDesktopIpc(): void {
  // Partial: the desktop reports its windows and files, the Browser app reports
  // its tabs, and neither should erase the other's half.
  ipcMain.on('desktop:report', (_e, patch: Partial<DesktopSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
  })
  // The Computer closing takes the whole desktop off screen with it; leaving
  // the last snapshot behind would have the agent describing windows that are
  // not there.
  ipcMain.on('desktop:gone', () => {
    snapshot = { ...empty }
  })
}

/** Human-readable, because that is what the agent is going to read. */
export function describeDesktop(): string {
  const s = snapshot
  if (!s.open) {
    return 'The Computer is not open on screen right now, so nothing is visible on the desktop.'
  }
  const lines: string[] = [`The desktop is ${s.bounds.w}x${s.bounds.h}.`]

  if (s.windows.length === 0) {
    lines.push('No windows are open.')
  } else {
    lines.push('Windows:')
    for (const w of s.windows) {
      const where = w.maximized
        ? 'filling the desktop'
        : `at ${Math.round(w.x)},${Math.round(w.y)} — ${Math.round(w.w)}x${Math.round(w.h)}`
      const state = w.minimized ? 'minimised' : w.focused ? 'in front' : 'behind'
      lines.push(`  ${w.app} — ${state}, ${where}`)
    }
  }

  if (s.tabs.length) {
    lines.push('Browser tabs:')
    for (const t of s.tabs) {
      lines.push(`  ${t.url || 'about:blank'}${t.active ? '  <-- the one on screen' : ''}`)
    }
  }

  lines.push(
    s.files.length
      ? `Files on the desktop (also readable at ./files/ from your working directory):\n${s.files
          .map((f) => `  ${f.name} — ${f.path}`)
          .join('\n')}`
      : 'No files on the desktop.'
  )

  return lines.join('\n')
}
