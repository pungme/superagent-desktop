import { useEffect, useMemo, useRef, useState } from 'react'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { highlightFile, languageLabel } from '../lib/editor-highlight'
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

  // Re-read the file after Claude finishes a turn, so a file the agent just
  // edited updates on screen instead of showing stale content. Skipped while you
  // are editing it yourself, so it can never clobber your unsaved changes.
  useEffect(() => {
    if (editing) return
    const onIdle = (): void => {
      window.cove.fileRead?.(path)?.then((text) => {
        if (typeof text === 'string' && text !== savedRef.current) {
          setContent(text)
          setDraft(text)
          savedRef.current = text
        }
      })
    }
    window.addEventListener('cove:workspace-idle', onIdle)
    return () => window.removeEventListener('cove:workspace-idle', onIdle)
  }, [path, editing])

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
            <CodeEditor
              text={draft}
              ext={extOf(path)}
              onChange={setDraft}
              onSave={() => {
                if (dirty && !saving) save()
              }}
            />
          ) : isMarkdown(path) ? (
            <div className="file-viewer-md">
              <Markdown text={content} />
            </div>
          ) : (
            <HighlightedCode text={content} ext={extOf(path)} />
          ))}
      </div>
      {editing && typeof content === 'string' && (
        <div className="file-viewer-foot">
          <span>{languageLabel(extOf(path))}</span>
          <span className="file-viewer-foot-spacer" />
          <span>{countWords(draft).toLocaleString()} words</span>
          <span>{draft.split('\n').length.toLocaleString()} lines</span>
          <span className={dirty ? 'file-viewer-foot-edited' : ''}>
            {saving ? 'Saving…' : dirty ? 'Edited · ⌘S to save' : 'Saved'}
          </span>
        </div>
      )}
    </div>
  )
}

const countWords = (s: string): number => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

function HighlightedCode({ text, ext }: { text: string; ext: string }): React.JSX.Element {
  const html = useMemo(() => highlightFile(text, ext), [text, ext])
  return <pre className="file-viewer-code" dangerouslySetInnerHTML={{ __html: html }} />
}

/** Insert text at the caret through the browser, so ⌘Z can undo it. */
const insertText = (text: string): void => {
  document.execCommand('insertText', false, text)
}

/**
 * A plain textarea with its text made transparent, over a layer that draws the
 * same text coloured. Same font, size, padding and wrapping on both, so the
 * caret and selection sit exactly on the glyphs; typing, undo, IME, spellcheck
 * and accessibility stay the browser's own. Both sit in one grid cell: the
 * coloured layer sets the height and the pane around them scrolls.
 */
function CodeEditor({
  text,
  ext,
  onChange,
  onSave
}: {
  text: string
  ext: string
  onChange: (s: string) => void
  onSave: () => void
}): React.JSX.Element {
  const md = ext === 'md' || ext === 'markdown'
  const html = useMemo(() => highlightFile(text, ext), [text, ext])
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(0, 0)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    // ⌘/Ctrl+S saves without leaving edit mode.
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      onSave()
      return
    }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const { selectionStart: a, selectionEnd: b, value } = el
      const lineStart = value.lastIndexOf('\n', a - 1) + 1
      if (e.shiftKey) {
        // Outdent the current line by up to two spaces (or one tab).
        const lead = /^( {1,2}|\t)/.exec(value.slice(lineStart))
        if (lead) {
          el.setSelectionRange(lineStart, lineStart + lead[0].length)
          insertText('')
          el.setSelectionRange(
            Math.max(lineStart, a - lead[0].length),
            Math.max(lineStart, b - lead[0].length)
          )
        }
      } else if (a === b) {
        insertText('  ')
      } else {
        // Indent the selected lines.
        const end = value.indexOf('\n', b - 1 >= a ? b - 1 : b)
        const blockEnd = end === -1 ? value.length : end
        const block = value.slice(lineStart, blockEnd)
        el.setSelectionRange(lineStart, blockEnd)
        const indented = block.replace(/^/gm, '  ')
        insertText(indented)
        el.setSelectionRange(lineStart, lineStart + indented.length)
      }
      return
    }
    // In Markdown, Return in a list continues it; Return on an empty item ends it.
    if (
      md &&
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing
    ) {
      const { selectionStart: a, selectionEnd: b, value } = el
      if (a !== b) return
      const lineStart = value.lastIndexOf('\n', a - 1) + 1
      const before = value.slice(lineStart, a)
      const m = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s)?(.*)$/.exec(before)
      if (!m) return
      e.preventDefault()
      const lineEnd = value.indexOf('\n', a)
      const after = value.slice(a, lineEnd === -1 ? value.length : lineEnd)
      if (!m[7].trim() && !after.trim()) {
        // Empty item: drop the marker and leave the list.
        el.setSelectionRange(lineStart, a)
        insertText('')
        return
      }
      const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2]
      insertText(`\n${m[1]}${marker}${m[5]}${m[6] ? '[ ] ' : ''}`)
    }
  }

  return (
    <div
      className={`fv-editor ${md ? 'fv-editor-prose' : ''}`}
      onMouseDown={(e) => {
        // A click in the margin below the text puts the caret at the end.
        const el = ref.current
        if (!el || e.target === el) return
        e.preventDefault()
        el.focus({ preventScroll: true })
        el.setSelectionRange(el.value.length, el.value.length)
      }}
    >
      {/* The trailing newline + space keeps a final empty line as tall as the textarea's. */}
      <pre
        className="fv-editor-layer"
        aria-hidden
        dangerouslySetInnerHTML={{ __html: `${html}\n ` }}
      />
      <textarea
        ref={ref}
        className="fv-editor-input"
        value={text}
        spellCheck={md}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
