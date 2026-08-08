import { useCallback, useEffect, useState } from 'react'

interface DeskFile {
  path: string
  name: string
}

const KEY = 'cove.desktopFiles'

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
 * The desktop: a surface with a picture on it and whatever you've dropped
 * there. Deliberately plain for now — drag files in, double-click to open,
 * drag them back out of the list to remove. It is not a file manager.
 */
export function DesktopPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [files, setFiles] = useState<DeskFile[]>(load)
  const [over, setOver] = useState(false)
  /** Which menu-bar title is open, if any. */
  const [menu, setMenu] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'kind'>('name')

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
      className={`desktop-view ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {/* A menu bar, the way a desktop has one. Click a title to open it;
          clicking anywhere else puts it away. */}
      <div className="desktop-menubar" onClick={(e) => e.stopPropagation()}>
        <span className="desktop-menu-mark">◉</span>
        <div className="desktop-menu">
          <button
            className={`desktop-menu-title ${menu === 'file' ? 'on' : ''}`}
            onClick={() => setMenu((m) => (m === 'file' ? null : 'file'))}
          >
            File
          </button>
          {menu === 'file' && (
            <div className="desktop-menu-drop">
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
        <div className="desktop-menu">
          <button
            className={`desktop-menu-title ${menu === 'view' ? 'on' : ''}`}
            onClick={() => setMenu((m) => (m === 'view' ? null : 'view'))}
          >
            View
          </button>
          {menu === 'view' && (
            <div className="desktop-menu-drop">
              <button onClick={() => { setSort('name'); setMenu(null) }}>
                {sort === 'name' ? '✓ ' : '\u00a0\u00a0'}Sort by name
              </button>
              <button onClick={() => { setSort('kind'); setMenu(null) }}>
                {sort === 'kind' ? '✓ ' : '\u00a0\u00a0'}Sort by kind
              </button>
            </div>
          )}
        </div>
        <div className="desktop-head-spacer" />
        <span className="desktop-sub">
          {files.length === 0 ? 'Drop files here' : `${files.length} item${files.length === 1 ? '' : 's'}`}
        </span>
        <button className="desktop-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="desktop-surface" onClick={() => setMenu(null)}>
        {sorted.map((f) => (
          <button
            key={f.path}
            className="desktop-file"
            title={f.path}
            onDoubleClick={() => void window.cove.filesOpenExternal?.(f.path)}
          >
            <span className="desktop-file-icon">{iconFor(f.name)}</span>
            <span className="desktop-file-name">{f.name}</span>
            <span
              className="desktop-file-x"
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
          <div className="desktop-empty">Drag a file in from Finder.</div>
        )}
      </div>
    </div>
  )
}
