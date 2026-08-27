import { useEffect, useRef, useState } from 'react'

interface Branch {
  name: string
  current: boolean
  worktree: string | null
}

/**
 * A dropdown of a repo's branches. Used two ways: switch the checkout to a branch
 * (toolbar), or open a branch in a worktree (the New-worktree picker). The parent
 * decides what picking does via onPick; onNew (when given) adds a "new branch" row.
 */
export function BranchMenu({
  cwd,
  onPick,
  onNew,
  onClose,
  pickDisabledInWorktree = false
}: {
  cwd: string
  /** An existing branch was chosen. */
  onPick: (branch: string) => void
  /** Optional: create a new branch of this name. */
  onNew?: (name: string) => void
  onClose: () => void
  /** Switching can't target a branch already in a worktree; grey those out. */
  pickDisabledInWorktree?: boolean
}): React.JSX.Element {
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [filter, setFilter] = useState('')
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.cove.gitBranches(cwd).then(setBranches)
  }, [cwd])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
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
  }, [onClose])

  const shown = (branches ?? []).filter((b) =>
    b.name.toLowerCase().includes(filter.trim().toLowerCase())
  )

  return (
    <div className="branch-menu" ref={ref}>
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
    </div>
  )
}
