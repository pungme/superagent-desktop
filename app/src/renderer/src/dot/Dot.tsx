import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { ProjectIcon } from '../components/ProjectIcon'
import { useProjectIcon } from '../hooks/useProjectIcon'
import { useDictation } from '../lib/dictation'
import { applyDelta, applyEvent, elapsed, newTask, suggestions, type DotTask } from './dot-state'
import './dot.css'

interface Project {
  id: string
  name: string
  kind: string
  path: string
  usedAt: number
  pinned: boolean
}

const COMPUTER = '__desktop_chat__'
const LAST_PROJECT = 'cove.dotProject'

/** A project's own icon; the Mac itself gets a screen. */
function Mark({ project, size = 16 }: { project: Project; size?: number }): React.JSX.Element {
  const icon = useProjectIcon(project.id, project.path, project.kind)
  if (project.kind === 'computer')
    return (
      <svg
        className="dot-mark-computer"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.4" />
        <path d="M6 14h4" />
      </svg>
    )
  return <ProjectIcon icon={icon} kind={project.kind} size={size} />
}

/**
 * Superagent as a tile in the corner of the screen. See main/dot.ts for the
 * window it lives in; this is everything drawn in it.
 */
export function Dot(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState('')
  /** The row the arrow keys are on, in the list as filtered. */
  const [cursor, setCursor] = useState(0)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState(() => localStorage.getItem(LAST_PROJECT) ?? COMPUTER)
  const [text, setText] = useState('')
  const [task, setTask] = useState<DotTask | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  /** A finished answer nobody has looked at yet. */
  const [unseen, setUnseen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const dictation = useDictation()
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) ?? projects[0] ?? null,
    [projects, projectId]
  )
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, filter])

  const loadProjects = useCallback((): void => {
    void window.cove.dotProjects().then(setProjects)
  }, [])
  useEffect(() => {
    loadProjects()
    return window.cove.onProjectsChanged?.(loadProjects)
  }, [loadProjects])

  // The window is as big as the open panel all the time and see-through where
  // nothing is drawn; main is told whenever the pointer crosses that line, so
  // clicks elsewhere go to whatever is underneath.
  useEffect(() => {
    let solid = false
    const onMove = (e: MouseEvent): void => {
      const over = !!(e.target as Element | null)?.closest?.('[data-solid]')
      if (over !== solid) {
        solid = over
        window.cove.dotSolid(over)
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  const show = useCallback((): void => {
    setOpen(true)
    setUnseen(false)
    loadProjects()
    window.cove.dotFocus(true)
    // After the panel has mounted.
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [loadProjects])
  const hide = useCallback((): void => {
    setOpen(false)
    setPicking(false)
    setFilter('')
    window.cove.dotFocus(false)
  }, [])

  useEffect(() => window.cove.onDotSummon(() => (openRef.current ? hide() : show())), [hide, show])

  // The chat's events, as the phone would receive them.
  useEffect(() => {
    const offEvent = window.cove.onDotEvent((p) =>
      setTask((t) => {
        if (!t) return t
        const next = applyEvent(t, p.chatId, p.data)
        if (next !== t && next.status !== t.status && next.status !== 'working' && !openRef.current)
          setUnseen(true)
        return next
      })
    )
    const offDelta = window.cove.onDotDelta((p) =>
      setTask((t) => (t ? applyDelta(t, p.chatId, p.text) : t))
    )
    return () => {
      offEvent()
      offDelta()
    }
  }, [])

  const working = task?.status === 'working' || task?.status === 'needs'
  useEffect(() => {
    if (!working) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [working])

  const ask = async (said: string): Promise<void> => {
    const q = said.trim()
    if (!q || !project || sending) return
    setSending(true)
    setError('')
    const res = await window.cove.dotAsk(project.id, q)
    setSending(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    localStorage.setItem(LAST_PROJECT, project.id)
    setTask(newTask(res.chatId, res.workspaceId, q, Date.now()))
    setNow(Date.now())
    setText('')
  }

  const pick = (p: Project): void => {
    setProjectId(p.id)
    setPicking(false)
    setFilter('')
    setTimeout(() => inputRef.current?.focus(), 30)
  }

  const toggleMic = async (): Promise<void> => {
    if (dictation.state === 'recording') {
      const heard = (await dictation.stop()).trim()
      if (heard) setText((t) => (t ? `${t} ${heard}` : heard))
      inputRef.current?.focus()
    } else if (dictation.state === 'idle') await dictation.start()
  }

  // The tile is a button and a handle: a press that moves is a drag.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const onTileDown = (e: React.PointerEvent): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.screenX, y: e.screenY, moved: false }
  }
  const onTileMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.screenX - d.x
    const dy = e.screenY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 5) return
    d.moved = true
    d.x = e.screenX
    d.y = e.screenY
    window.cove.dotMove(dx, dy)
  }
  const onTileUp = (): void => {
    const d = drag.current
    drag.current = null
    if (d?.moved) window.cove.dotMoved()
    else if (open) hide()
    else show()
  }

  const listening = dictation.state === 'recording'
  const state = listening
    ? 'listening'
    : task?.status === 'needs'
      ? 'needs'
      : task?.status === 'working'
        ? 'working'
        : unseen && task?.status === 'done'
          ? 'done'
          : 'idle'
  const taskProject = task ? projects.find((p) => p.id === task.workspaceId) : null

  return (
    <div
      className="dot-root"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        if (picking) setPicking(false)
        else hide()
      }}
    >
      {open && project && (
        <div className="dot-panel" data-solid role="dialog" aria-label="Ask Superagent">
          <div className="dot-where">
            <span className="dot-where-in">In</span>
            <button
              className={`dot-chip ${picking ? 'open' : ''}`}
              aria-expanded={picking}
              aria-label={`Project: ${project.name}`}
              onClick={() => {
                setPicking((v) => !v)
                setCursor(
                  Math.max(
                    0,
                    projects.findIndex((p) => p.id === project.id)
                  )
                )
                setTimeout(() => filterRef.current?.focus(), 30)
              }}
            >
              <Mark project={project} />
              <span className="dot-chip-name">{project.name}</span>
              <span className="dot-chip-caret">{picking ? '▴' : '▾'}</span>
            </button>
          </div>

          {picking && (
            <div className="dot-menu" role="listbox" aria-label="Projects">
              <input
                ref={filterRef}
                className="dot-find"
                placeholder="Find a project…"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value)
                  setCursor(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const step = e.key === 'ArrowDown' ? 1 : -1
                    setCursor((c) => (shown.length ? (c + step + shown.length) % shown.length : 0))
                  }
                  const at = shown[Math.min(cursor, shown.length - 1)]
                  if (e.key === 'Enter' && at) pick(at)
                }}
              />
              <div className="dot-menu-list">
                {shown.map((p, i) => (
                  <button
                    key={p.id}
                    role="option"
                    aria-selected={i === cursor}
                    className={`dot-item ${i === cursor ? 'on' : ''}`}
                    ref={
                      i === cursor ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined
                    }
                    onMouseMove={() => setCursor(i)}
                    onClick={() => pick(p)}
                  >
                    <Mark project={p} />
                    <span className="dot-item-name">{p.name}</span>
                    <span className="dot-item-note">
                      {p.id === project.id
                        ? '✓'
                        : p.kind === 'computer'
                          ? 'this Mac'
                          : p.pinned
                            ? 'pinned'
                            : ''}
                    </span>
                  </button>
                ))}
                {shown.length === 0 && <div className="dot-empty">No project by that name.</div>}
              </div>
            </div>
          )}

          {task && !picking && (
            <div className={`dot-task dot-task-${task.status}`}>
              <div className="dot-you">{task.question}</div>
              {task.status === 'needs' && task.approval ? (
                <>
                  <div className="dot-approval">
                    {task.approval.preview || task.approval.toolName}
                  </div>
                  <div className="dot-row">
                    <span className="dot-quiet">It needs your yes to carry on.</span>
                    <button
                      className="dot-btn"
                      onClick={() => void window.cove.dotAnswer(task.approval!.id, false)}
                    >
                      Not now
                    </button>
                    <button
                      className="dot-btn primary"
                      onClick={() => void window.cove.dotAnswer(task.approval!.id, true)}
                    >
                      Allow
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {task.status === 'working' && (
                    <div className="dot-steps">
                      {task.steps.slice(-3).map((s, i, all) => (
                        <div
                          key={`${i}-${s}`}
                          className={`dot-step ${i === all.length - 1 ? 'now' : ''}`}
                        >
                          <i />
                          <span>{s}</span>
                        </div>
                      ))}
                      {task.steps.length === 0 && !task.live && !task.answer && (
                        <div className="dot-step now">
                          <i />
                          <span>Starting…</span>
                        </div>
                      )}
                    </div>
                  )}
                  {(task.answer || task.live) && (
                    <div className="dot-answer">
                      <Markdown
                        text={task.live || task.answer}
                        streaming={task.status === 'working'}
                      />
                    </div>
                  )}
                  {task.status === 'failed' && <div className="dot-error">{task.error}</div>}
                  <div className="dot-row">
                    {task.status === 'working' ? (
                      <>
                        <span className="dot-quiet">{elapsed(now - task.startedAt)}</span>
                        <button
                          className="dot-btn"
                          onClick={() => void window.cove.dotStop(task.chatId)}
                        >
                          Stop
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="dot-link"
                          onClick={() => window.cove.dotOpen(task.chatId)}
                        >
                          Open in Superagent ↗
                        </button>
                        <button className="dot-btn" onClick={() => setTask(null)}>
                          Clear
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {!picking && (
            <>
              <div className={`dot-ask ${listening ? 'listening' : ''}`}>
                <textarea
                  ref={inputRef}
                  className="dot-input"
                  rows={1}
                  placeholder={
                    listening
                      ? 'Listening…'
                      : task
                        ? 'Ask something else…'
                        : 'Ask, or tell it what to do…'
                  }
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value)
                    e.target.style.height = 'auto'
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void ask(text)
                    }
                    if (e.key === 'Tab' && !text) {
                      e.preventDefault()
                      setCursor(
                        Math.max(
                          0,
                          projects.findIndex((p) => p.id === project.id)
                        )
                      )
                      setPicking(true)
                      setTimeout(() => filterRef.current?.focus(), 30)
                    }
                  }}
                />
                <button
                  className={`dot-mic ${listening ? 'on' : ''}`}
                  title={listening ? 'Stop and use what I said' : 'Speak instead of typing'}
                  aria-label="Dictate"
                  disabled={
                    dictation.state === 'transcribing' || dictation.state === 'loading-model'
                  }
                  onClick={() => void toggleMic()}
                >
                  {dictation.state === 'transcribing' || dictation.state === 'loading-model' ? (
                    <span className="dot-spin" />
                  ) : (
                    <span
                      className="dot-mic-dot"
                      style={{ scale: String(1 + dictation.level * 0.9) }}
                    />
                  )}
                </button>
              </div>
              {(error || dictation.error) && (
                <div className="dot-error" role="alert">
                  {error || dictation.error}
                </div>
              )}
              {!task && !text && (
                <div className="dot-suggest">
                  {suggestions(project.kind).map((s) => (
                    <button
                      key={s}
                      className="dot-suggestion"
                      onClick={() => {
                        // One that ends in a colon is a start to finish typing.
                        if (s.endsWith(': ')) {
                          setText(s)
                          inputRef.current?.focus()
                        } else void ask(s)
                      }}
                    >
                      {s.replace(/: $/, '…')}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {working && taskProject && !open && (
        <div className="dot-tag" data-solid>
          <Mark project={taskProject} size={13} />
          {taskProject.name}
        </div>
      )}
      {unseen && !open && <div className="dot-badge">1</div>}
      <button
        className={`dot-tile dot-${state}`}
        data-solid
        aria-label="Superagent"
        title={open ? 'Close' : 'Ask Superagent  ⌥Space'}
        onPointerDown={onTileDown}
        onPointerMove={onTileMove}
        onPointerUp={onTileUp}
        onPointerCancel={() => (drag.current = null)}
      >
        <span className="dot-core" />
      </button>
    </div>
  )
}
