import { useState } from 'react'
import { useStore, TodoItem } from '../state'

const EMPTY: TodoItem[] = []

function statusIcon(status: TodoItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '◐'
  return '○'
}

/**
 * Live task list for a workspace, shown above the composer. Mirrors Claude's
 * TodoWrite list and lets the user add their own tasks, which are sent to Claude
 * to fold into that list. Collapsed by default; auto-shows the active task.
 */
export function TasksPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const todos = useStore((s) => s.todos[workspaceId] ?? EMPTY)
  const sendToClaude = useStore((s) => s.sendToClaude)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')

  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')

  // Nothing to show and the user hasn't opened it — stay out of the way.
  if (todos.length === 0 && !expanded) {
    return (
      <button className="easy-tasks-open" onClick={() => setExpanded(true)} title="Add a task">
        ✓ Add task
      </button>
    )
  }

  const addTask = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    // Ask Claude to fold it into its own task list (it may reword into an
    // actionable form); TodoWrite then flows back and updates this panel live.
    sendToClaude(
      workspaceId,
      `Add this to your task list (rewrite it into a clear, actionable task if needed) and work through it: ${text}`
    )
  }

  return (
    <div className="easy-tasks">
      <button
        className="easy-tasks-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="easy-tasks-caret" style={{ transform: expanded ? 'none' : 'rotate(-90deg)' }}>
          ▾
        </span>
        <span className="easy-tasks-title">Tasks</span>
        {todos.length > 0 && (
          <span className="easy-tasks-count">
            {done}/{todos.length}
          </span>
        )}
        {!expanded && active && (
          <span className="easy-tasks-active">{active.activeForm || active.content}</span>
        )}
      </button>

      {expanded && (
        <div className="easy-tasks-body">
          {todos.map((t, i) => (
            <div key={i} className={`easy-task easy-task-${t.status}`}>
              <span className="easy-task-icon">{statusIcon(t.status)}</span>
              <span className="easy-task-text">
                {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
              </span>
            </div>
          ))}
          {todos.length === 0 && <div className="easy-tasks-empty">No tasks yet.</div>}
          <div className="easy-tasks-add">
            <input
              className="easy-tasks-input"
              placeholder="Add a task for Claude…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTask()
                }
              }}
            />
            <button className="easy-tasks-add-btn" onClick={addTask} disabled={!draft.trim()}>
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
