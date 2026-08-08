import { useCallback, useEffect, useState } from 'react'
import { useEscapeClose } from '../hooks/useEscapeClose'

interface DeskFile {
  path: string
  name: string
}

const KEY = 'cove.computerFiles'

function load(): DeskFile[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as DeskFile[]) : []
  } catch {
    return []
  }
}

function iconFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(ext)) return '🖼'
  if (['pdf'].includes(ext)) return '📕'
  if (['md', 'txt', 'rtf'].includes(ext)) return '📝'
  if (['zip', 'tar', 'gz', 'dmg'].includes(ext)) return '🗜'
  if (['mov', 'mp4', 'm4v'].includes(ext)) return '🎬'
  if (!ext) return '📁'
  return '📄'
}

/**
 * Your computer: a surface that holds the things you want to hand, across
 * projects. Files you drop live here and open on double-click.
 *
 * Deliberately small. It was removed once for being an empty room with a
 * decorative menu bar, so it earns its place by holding something or saying
 * plainly that it doesn't yet — no chrome for its own sake.
 */
export function ComputerPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [files, setFiles] = useState<DeskFile[]>(load)
  const [over, setOver] = useState(false)
  /** Which menu-bar title is open, if any. */
  const [menu, setMenu] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'kind'>('name')
  // Escape peels one layer: an open menu first, then the desktop itself.
  useEscapeClose(menu ? () => setMenu(null) : onClose)

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(files))
  }, [files])

  const add = useCallback((paths: string[]): void => {
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => f.path))
      const fresh = paths
        .filter((p) => p && !seen.has(p))
        .map((p) => ({ path: p, name: p.split('/').pop() || p }))
      return fresh.length ? [...cur, ...fresh] : cur
    })
  }, [])

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setOver(false)
    // Electron gives the real filesystem path via webUtils, not File.path.
    const paths = [...e.dataTransfer.files]
      .map((f) => window.cove.getPathForFile?.(f) ?? '')
      .filter(Boolean)
    add(paths)
  }

  const sorted = [...files].sort((a, b) =>
    sort === 'name'
      ? a.name.localeCompare(b.name)
      : (a.name.split('.').pop() ?? '').localeCompare(b.name.split('.').pop() ?? '') ||
        a.name.localeCompare(b.name)
  )

  return (
    <div
      className={`computer-view ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {/* A menu bar, the way a desktop has one. Click a title to open it;
          clicking anywhere else puts it away. */}
      <div className="computer-menubar" onClick={(e) => e.stopPropagation()}>
        <span className="computer-menu-mark">◉</span>
        <div className="computer-menu">
          <button
            className={`computer-menu-title ${menu === 'file' ? 'on' : ''}`}
            onClick={() => setMenu((m) => (m === 'file' ? null : 'file'))}
          >
            File
          </button>
          {menu === 'file' && (
            <div className="computer-menu-drop">
              <button
                onClick={() => {
                  setMenu(null)
                  setFiles([])
                }}
                disabled={files.length === 0}
              >
                Clear the desktop
              </button>
            </div>
          )}
        </div>
        <div className="computer-menu">
          <button
            className={`computer-menu-title ${menu === 'view' ? 'on' : ''}`}
            onClick={() => setMenu((m) => (m === 'view' ? null : 'view'))}
          >
            View
          </button>
          {menu === 'view' && (
            <div className="computer-menu-drop">
              <button onClick={() => { setSort('name'); setMenu(null) }}>
                {sort === 'name' ? '✓ ' : '\u00a0\u00a0'}Sort by name
              </button>
              <button onClick={() => { setSort('kind'); setMenu(null) }}>
                {sort === 'kind' ? '✓ ' : '\u00a0\u00a0'}Sort by kind
              </button>
            </div>
          )}
        </div>
        <div className="computer-head-spacer" />
        <span className="computer-sub">
          {files.length === 0 ? 'Drop files here' : `${files.length} item${files.length === 1 ? '' : 's'}`}
        </span>
        <button className="computer-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="computer-surface" onClick={() => setMenu(null)}>
        {sorted.map((f) => (
          <button
            key={f.path}
            className="computer-file"
            title={f.path}
            onDoubleClick={() => void window.cove.filesOpenExternal?.(f.path)}
          >
            <span className="computer-file-icon">{iconFor(f.name)}</span>
            <span className="computer-file-name">{f.name}</span>
            <span
              className="computer-file-x"
              title="Take it off the desktop"
              onClick={(e) => {
                e.stopPropagation()
                setFiles((cur) => cur.filter((x) => x.path !== f.path))
              }}
            >
              ✕
            </span>
          </button>
        ))}
        {files.length === 0 && (
          <div className="computer-empty">Drag a file in from Finder.</div>
        )}
      </div>
    </div>
  )
}
