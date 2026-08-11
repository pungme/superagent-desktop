import { useState } from 'react'
import { useStore, TodoItem } from '../state'

const EMPTY: TodoItem[] = []

function statusIcon(status: TodoItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '◐'
  return '○'
}

/**
 * Sticky display of Claude's own todo list (from TodoWrite), pinned at the top
 * of the chat so you can watch it work through the plan. Read-only — this just
 * surfaces the list Claude already maintains; it's not a separate task manager.
 * Hidden entirely when there are no todos.
 */
export function TasksPanel({ chatId }: { chatId: string }): React.JSX.Element | null {
  const todos = useStore((s) => s.todos[chatId] ?? EMPTY)
  const [collapsed, setCollapsed] = useState(false)

  if (todos.length === 0) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')
  const allDone = done === todos.length

  return (
    <div className="easy-tasks">
      <button
        className="easy-tasks-header"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <span
          className="easy-tasks-caret"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
        >
          ▾
        </span>
        <span className="easy-tasks-title">{allDone ? 'Tasks done' : 'Tasks'}</span>
        <span className="easy-tasks-count">
          {done}/{todos.length}
        </span>
        {collapsed && active && (
          <span className="easy-tasks-active">{active.activeForm || active.content}</span>
        )}
      </button>

      {!collapsed && (
        <div className="easy-tasks-body">
          {todos.map((t, i) => (
            <div key={i} className={`easy-task easy-task-${t.status}`}>
              <span className="easy-task-icon">{statusIcon(t.status)}</span>
              <span className="easy-task-text">
                {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
