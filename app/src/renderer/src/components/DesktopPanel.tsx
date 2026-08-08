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
      <div className="desktop-head">
        <h2>Desktop</h2>
        <span className="desktop-sub">
          {files.length === 0 ? 'Drop files here to keep them to hand' : `${files.length} item${files.length === 1 ? '' : 's'}`}
        </span>
        <div className="desktop-head-spacer" />
        <button className="desktop-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="desktop-surface">
        {files.map((f) => (
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
