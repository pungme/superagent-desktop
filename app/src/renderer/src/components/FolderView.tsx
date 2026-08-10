import { useCallback, useEffect, useRef, useState } from 'react'
import { DeskEntry, announceDeskChange } from './deskEvents'

/**
 * The contents of one folder on the desk, shown in a window.
 *
 * Double-clicking a folder opens one of these — the way a desktop does, rather
 * than replacing the desk under you. It reads the real folder (the desk is a
 * real directory), opens files and sub-folders through the callbacks it is
 * given, and can select, rename, move and remove — every mutation announces
 * itself so any other window showing the same folder redraws.
 */

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'avif', 'tiff']
const isImage = (name: string): boolean =>
  IMAGE_EXT.includes(name.split('.').pop()?.toLowerCase() ?? '')

function iconFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['pdf'].includes(ext)) return '📕'
  if (['md', 'txt', 'rtf'].includes(ext)) return '📝'
  if (['zip', 'tar', 'gz', 'dmg'].includes(ext)) return '🗜'
  if (['mov', 'mp4', 'm4v'].includes(ext)) return '🎬'
  return '📄'
}

export function FolderView({
  dir,
  onOpenFolder,
  onOpenFile
}: {
  dir: string
  onOpenFolder: (path: string) => void
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const [entries, setEntries] = useState<DeskEntry[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const anchorRef = useRef<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const list = await window.cove.deskList?.(dir)
    if (list) setEntries(list)
  }, [dir])

  useEffect(() => {
    void refresh()
    // A drop or a rename in another window that touches this folder should show
    // here too.
    const onChange = (): void => void refresh()
    window.addEventListener('cove:desk-changed', onChange)
    return () => window.removeEventListener('cove:desk-changed', onChange)
  }, [refresh])

  // Thumbnails for the pictures, so a folder of screenshots shows the pictures.
  useEffect(() => {
    let alive = true
    const wanted = entries.filter((e) => !e.dir && isImage(e.name) && !(e.path in thumbs))
    if (!wanted.length) return
    void Promise.all(
      wanted.map(async (e) => [e.path, await window.cove.filesThumb?.(e.target || e.path)] as const)
    ).then((pairs) => {
      if (!alive) return
      const next: Record<string, string> = {}
      for (const [path, uri] of pairs) next[path] = uri ?? ''
      setThumbs((cur) => ({ ...cur, ...next }))
    })
    return () => {
      alive = false
    }
  }, [entries, thumbs])

  const order = entries.map((e) => e.path)
  const pick = (path: string, e: React.MouseEvent): void => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((cur) => (cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]))
      anchorRef.current = path
      return
    }
    if (e.shiftKey && anchorRef.current) {
      const a = order.indexOf(anchorRef.current)
      const b = order.indexOf(path)
      if (a >= 0 && b >= 0) {
        setSelected(order.slice(Math.min(a, b), Math.max(a, b) + 1))
        return
      }
    }
    setSelected([path])
    anchorRef.current = path
  }

  const commitRename = (): void => {
    const path = renaming
    const name = draft.trim()
    setRenaming(null)
    if (!path || !name) return
    void window.cove.deskRename?.(path, name).then(() => {
      announceDeskChange()
      void refresh()
    })
  }

  const removeEntry = (path: string): void => {
    void window.cove.deskRemove?.(path).then(() => {
      announceDeskChange()
      void refresh()
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || renaming || selected.length !== 1) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      const f = entries.find((x) => x.path === selected[0])
      if (f) {
        e.preventDefault()
        setDraft(f.name)
        setRenaming(f.path)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [renaming, selected, entries])

  return (
    <div className="folderview" onClick={() => setSelected([])}>
      {entries.length === 0 && <div className="folderview-empty">This folder is empty.</div>}
      <div className="computer-icons">
        {entries.map((f) => (
          <button
            key={f.path}
            className={`computer-icon computer-file ${selected.includes(f.path) ? 'selected' : ''}`}
            data-path={f.path}
            title={f.path}
            onClick={(e) => {
              e.stopPropagation()
              pick(f.path, e)
            }}
            onDoubleClick={() => (f.dir ? onOpenFolder(f.path) : onOpenFile(f.target || f.path))}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/desk-path', f.path)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (f.dir) {
                e.preventDefault()
                e.stopPropagation()
              }
            }}
            onDrop={(e) => {
              if (!f.dir) return
              e.preventDefault()
              e.stopPropagation()
              const moving = e.dataTransfer.getData('text/desk-path')
              if (!moving) return
              const many = selected.includes(moving) ? selected : [moving]
              void (async () => {
                for (const src of many) await window.cove.deskMove?.(src, f.path)
                setSelected([])
                announceDeskChange()
                await refresh()
              })()
            }}
          >
            <span className="computer-file-icon">
              {f.dir ? '📁' : thumbs[f.path] ? (
                <img className="computer-file-thumb" src={thumbs[f.path]} alt="" />
              ) : (
                iconFor(f.name)
              )}
            </span>
            {renaming === f.path ? (
              <input
                className="computer-icon-rename"
                value={draft}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span
                className="computer-icon-name"
                onClick={(e) => {
                  if (selected.length === 1 && selected[0] === f.path) {
                    e.stopPropagation()
                    setDraft(f.name)
                    setRenaming(f.path)
                  }
                }}
              >
                {f.name}
              </span>
            )}
            <span
              className="computer-file-x"
              title={f.link ? 'Take it off the desktop — the file stays where it is' : 'Move to Trash'}
              onClick={(e) => {
                e.stopPropagation()
                removeEntry(f.path)
              }}
            >
              ✕
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
