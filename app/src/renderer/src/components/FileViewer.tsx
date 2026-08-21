import { useEffect, useRef, useState } from 'react'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { Markdown } from './Markdown'

interface FileViewerProps {
  path: string
  /** The project root, so the header can show where the file sits (relative path). */
  cwd?: string
  onClose: () => void
  /**
   * Inside a desktop window the frame already carries the filename and a close
   * button, so the viewer drops its own rather than showing each of them twice.
   */
  embedded?: boolean
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const extOf = (p: string): string => p.slice(p.lastIndexOf('.') + 1).toLowerCase()
const isMarkdown = (p: string): boolean => extOf(p) === 'md' || extOf(p) === 'markdown'

/**
 * In-app viewer/editor for a text file. Markdown renders formatted (View); any
 * text file can be edited in place (Edit → Save). Sits in the content pane where
 * the browser preview would go — so binary previews (PDF/images) still use the
 * native pane, but text no longer shows as Chromium's raw text/plain.
 */
export function FileViewer({ path, cwd, onClose, embedded }: FileViewerProps): React.JSX.Element {
  // Where the file sits inside the project — the folders above it, so the header
  // shows more than a bare name (a folder full of similarly-named files is common).
  const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
  const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  // null = still loading; false = unreadable (too large / binary → offer the OS).
  const [content, setContent] = useState<string | null | false>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  // The last saved text, so we know whether the draft has unsaved changes.
  const savedRef = useRef('')

  useEffect(() => {
    let alive = true
    setContent(null)
    setEditing(false)
    // Optional-chained so a stale preload (mid hot-reload) can't crash the app.
    const read = window.cove.fileRead?.(path)
    if (!read) {
      setContent(false)
      return () => {
        alive = false
      }
    }
    read.then((text) => {
      if (!alive) return
      if (text === null) {
        setContent(false)
        return
      }
      setContent(text)
      setDraft(text)
      savedRef.current = text
    })
    return () => {
      alive = false
    }
  }, [path])

  const dirty = editing && draft !== savedRef.current
  // Not while there are unsaved edits — Escape must not be how you lose them.
  useEscapeClose(onClose, !dirty)

  const save = async (): Promise<void> => {
    setSaving(true)
    const ok = await window.cove.fileWrite?.(path, draft)
    setSaving(false)
    if (ok) {
      savedRef.current = draft
      setContent(draft)
    }
  }

  return (
    <div className="file-viewer">
      <div className="file-viewer-bar">
        {!embedded && (
          <span className="file-viewer-title" title={path}>
            <span className="file-viewer-name">{basename(path)}</span>
            {relDir && <span className="file-viewer-path">{relDir}</span>}
          </span>
        )}
        {dirty && <span className="file-viewer-dot" title="Unsaved changes" />}
        <div className="file-viewer-spacer" />
        {content !== false && (
          <div className="file-viewer-tabs">
            <button
              className={`file-viewer-tab ${!editing ? 'on' : ''}`}
              onClick={() => setEditing(false)}
            >
              View
            </button>
            <button
              className={`file-viewer-tab ${editing ? 'on' : ''}`}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </div>
        )}
        {editing && (
          <button className="file-viewer-save" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {!embedded && (
          <button className="file-viewer-close" onClick={onClose} title="Close">
            ✕
          </button>
        )}
      </div>
      <div className="file-viewer-body">
        {content === null && <div className="file-viewer-msg">Loading…</div>}
        {content === false && (
          <div className="file-viewer-msg">
            <p>This file can’t be shown here (too large or not text).</p>
            <button onClick={() => window.cove.filesOpenExternal(path)}>Open in default app</button>
          </div>
        )}
        {content !== null &&
          content !== false &&
          (editing ? (
            <textarea
              className="file-viewer-edit"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // ⌘/Ctrl+S saves without leaving edit mode.
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault()
                  if (dirty && !saving) save()
                }
              }}
            />
          ) : isMarkdown(path) ? (
            <div className="file-viewer-md">
              <Markdown text={content} />
            </div>
          ) : (
            <pre className="file-viewer-code">{content}</pre>
          ))}
      </div>
    </div>
  )
}
