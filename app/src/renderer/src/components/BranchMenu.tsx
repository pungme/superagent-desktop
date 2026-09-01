import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayLock } from '../state'

interface Branch {
  name: string
  current: boolean
  worktree: string | null
}

/**
 * A dropdown of a repo's branches. Used two ways: switch the checkout to a branch
 * (toolbar), or open a branch in a worktree (the New-worktree picker). The parent
 * decides what picking does via onPick; onNew (when given) adds a "new branch" row.
 *
 * Rendered through a PORTAL at position:fixed — the menu opens over surfaces with
 * their own stacking contexts (message bubbles, sticky strips), and as a plain
 * absolute child it kept ending up painted UNDER them. A body-level fixed layer
 * escapes every ancestor stacking context by construction. (The native
 * browser/PDF view still paints above all HTML — the callers take the overlay
 * lock for that; this handles the HTML-vs-HTML stacking.)
 */
export function BranchMenu({
  cwd,
  anchor,
  align = 'left',
  onPick,
  onNew,
  onClose,
  pickDisabledInWorktree = false
}: {
  cwd: string
  /** The trigger element the menu positions itself under. */
  anchor: HTMLElement | null
  /** Which edge of the anchor the menu lines up with. */
  align?: 'left' | 'right'
  /** An existing branch was chosen. */
  onPick: (branch: string) => void
  /** Optional: create a new branch of this name. */
  onNew?: (name: string) => void
  onClose: () => void
  /** Switching can't target a branch already in a worktree; grey those out. */
  pickDisabledInWorktree?: boolean
}): React.JSX.Element | null {
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [filter, setFilter] = useState('')
  const [newName, setNewName] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const WIDTH = 260

  useEffect(() => {
    void window.cove.gitBranches(cwd).then(setBranches)
  }, [cwd])

  // Position under the anchor, clamped to the viewport.
  useLayoutEffect(() => {
    if (!anchor) return
    const place = (): void => {
      const r = anchor.getBoundingClientRect()
      const left = align === 'right' ? r.right - WIDTH : r.left
      setPos({
        top: Math.min(r.bottom + 6, window.innerHeight - 80),
        left: Math.max(8, Math.min(left, window.innerWidth - WIDTH - 8))
      })
    }
    place()
    // The anchor can move (resize, layout shifts) — follow it; scrolling any
    // ancestor just closes the menu rather than trying to track it.
    window.addEventListener('resize', place)
    const onScroll = (): void => onClose()
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, align, onClose])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current && !ref.current.contains(t) && !(anchor && anchor.contains(t))) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchor])

  // A menu drawn over the pane is drawn under it unless the pane is told.
  useOverlayLock(!!pos)

  if (!pos) return null

  const shown = (branches ?? []).filter((b) =>
    b.name.toLowerCase().includes(filter.trim().toLowerCase())
  )

  return createPortal(
    <div
      className="branch-menu"
      ref={ref}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: WIDTH }}
    >
      <input
        className="branch-menu-filter"
        placeholder="Find a branch…"
        value={filter}
        autoFocus
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="branch-menu-list">
        {branches === null ? (
          <div className="branch-menu-empty">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="branch-menu-empty">No branches</div>
        ) : (
          shown.map((b) => {
            const disabled = pickDisabledInWorktree && !!b.worktree && !b.current
            return (
              <button
                key={b.name}
                className={`branch-menu-item ${b.current ? 'current' : ''}`}
                disabled={disabled || b.current}
                title={
                  b.current
                    ? 'Current branch'
                    : b.worktree
                      ? `Checked out in a worktree: ${b.worktree}`
                      : b.name
                }
                onClick={() => onPick(b.name)}
              >
                <span className="branch-menu-glyph">⎇</span>
                <span className="branch-menu-name">{b.name}</span>
                {b.current && <span className="branch-menu-tag">current</span>}
                {!b.current && b.worktree && <span className="branch-menu-tag">worktree</span>}
              </button>
            )
          })
        )}
      </div>
      {onNew && (
        <form
          className="branch-menu-new"
          onSubmit={(e) => {
            e.preventDefault()
            const n = newName.trim()
            if (n) onNew(n)
          }}
        >
          <span className="branch-menu-glyph">＋</span>
          <input
            placeholder="New branch name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" disabled={!newName.trim()}>
            Create
          </button>
        </form>
      )}
    </div>,
    document.body
  )
}
