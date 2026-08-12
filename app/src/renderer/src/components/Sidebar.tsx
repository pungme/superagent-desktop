import { useEffect, useState } from 'react'
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable
} from '@dnd-kit/core'
import { useStore, WorkspaceStatus } from '../state'
import type { Workspace, Routine, Chat } from '../../../preload'

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  idle: 'Idle',
  working: 'Working…',
  'needs-you': 'Needs you'
}

// Shown when a project has no claude process — never opened this session, or
// reaped after sitting idle. The next message starts/resumes it.
const DORMANT_LABEL = 'No live session — your next message starts one'

/**
 * What the pane is showing, as a badge.
 *
 * It is a browser either way, but "a globe" answers a question nobody asked —
 * the useful thing is what you left open. A PDF and a picture are worth
 * distinguishing; anything else is a page, and a globe says that best.
 */
function pageBadge(url: string): { icon: React.JSX.Element; title: string } {
  const path = url.split(/[?#]/)[0].toLowerCase()
  const name = decodeURIComponent(path.split('/').pop() || '')
  const ext = name.slice(name.lastIndexOf('.') + 1)
  const svg = (children: React.ReactNode): React.JSX.Element => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
      {children}
    </svg>
  )
  if (ext === 'pdf') {
    return {
      title: `PDF open in this project${name ? ` — ${name}` : ''}`,
      icon: svg(
        <>
          <path d="M4 1.8h5l3 3v9.4H4z" />
          <path d="M9 1.9V5h3" />
        </>
      )
    }
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'heic'].includes(ext)) {
    return {
      title: `Image open in this project${name ? ` — ${name}` : ''}`,
      icon: svg(
        <>
          <rect x="2" y="3.2" width="12" height="9.6" rx="1.4" />
          <path d="M2.6 11l3.2-3.2 2.4 2.4 2-2 3.2 3.2" />
        </>
      )
    }
  }
  return {
    title: 'A page is open in this project',
    icon: svg(
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c3 3.2 3 8.8 0 12M8 2C5 5.2 5 10.8 8 14" />
      </>
    )
  }
}

// Stable empty routine list so the selector doesn't return a fresh array each render.
const EMPTY_ROUTINES: Routine[] = []
const EMPTY_CHATS: Chat[] = []
const EMPTY_PORTS: number[] = []

function StatusDot({
  status,
  live,
  browsing
}: {
  status: WorkspaceStatus
  live?: boolean
  browsing?: boolean
}): React.JSX.Element {
  // Driving the browser is work too — and on a plain tab there is no turn to
  // report, so without this the row sits at "idle" while the agent clicks
  // around in it.
  if (browsing) {
    return <span className="status-spinner" title="Claude is using this page" />
  }
  // A spinner while it works: a pulsing dot reads as a state, but the agent
  // running is an activity, and spinning says "still going" at a glance.
  if (status === 'working') {
    return <span className="status-spinner" title={STATUS_LABEL[status]} />
  }
  // Full dot while the agent is up; half a dot for half a session.
  if (status === 'idle' && !live) {
    return <span className="status-dot status-dormant" title={DORMANT_LABEL} />
  }
  return <span className={`status-dot status-${status}`} title={STATUS_LABEL[status]} />
}

// Crisp monochrome line icons (currentColor) — cleaner than emoji for project kind.
/** Bare hostname (no www.) for labeling a browser project by the site it's on. */
function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The branch chip, truncated in the row but shown in full on hover. The sidebar
 * scroller clips horizontally, so the tooltip is position:fixed (viewport-
 * relative) to escape it — a plain CSS ::after would be cut off. Anchored just
 * under the chip.
 */
function BranchChip({ branch }: { branch: string }): React.JSX.Element {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <span
        className="sidebar-item-branch"
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setTip({ x: r.left, y: r.bottom + 4 })
        }}
        onMouseLeave={() => setTip(null)}
      >
        ⎇ {branch}
      </span>
      {tip && (
        <span className="branch-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          {branch}
        </span>
      )}
    </>
  )
}

function KindIcon({ kind, size = 15 }: { kind: string; size?: number }): React.JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  return kind === 'browser' ? (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4" />
      <ellipse cx="8" cy="8" rx="3" ry="6.2" />
    </svg>
  ) : (
    <svg {...common}>
      <path d="M2 4.6c0-.6.4-1 1-1h2.9l1.4 1.6H13c.6 0 1 .4 1 1v5.2c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.6z" />
    </svg>
  )
}

// A properly-sized disclosure chevron (points down; rotate -90° when collapsed).
/** Stands in for the folder while a simulator is attached to the project. */
function PhoneIcon({ size = 15 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinejoin="round"
    >
      <rect x="4.6" y="1.6" width="6.8" height="12.8" rx="1.6" />
      <path d="M7 12.7h2" strokeLinecap="round" />
    </svg>
  )
}

function Chevron({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  )
}

function cadenceLabel(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
}

// While a routine runs, the current activity (its latest streamed step) so you
// can see what it's doing live from the sidebar.
function currentActivity(routine: Routine): string | null {
  if (routine.lastRunStatus !== 'running') return null
  try {
    const steps = JSON.parse(routine.lastRunTranscript || '[]') as Array<{
      kind: string
      name?: string
      text?: string
    }>
    const last = steps[steps.length - 1]
    if (!last) return 'starting…'
    if (last.kind === 'tool') return (last.name ?? 'working').replace(/^browser_/, '') + '…'
    if (last.text) return last.text.slice(0, 40)
    return 'working…'
  } catch {
    return 'running…'
  }
}

/** A routine shown nested under its project in the sidebar tree. */
function RoutineRow({ routine }: { routine: Routine }): React.JSX.Element {
  const openRoutineRun = useStore((s) => s.openRoutineRun)
  const status = routine.lastRunStatus
  const activity = currentActivity(routine)
  const dotTitle =
    status === 'running'
      ? 'Running now…'
      : status === 'error'
        ? 'Last run failed'
        : status === 'ok'
          ? 'Last run ok'
          : 'Not run yet'
  return (
    <div
      className={`routine-tree-row ${routine.enabled ? '' : 'disabled'}`}
      title={routine.prompt}
      // Open the run transcript — what the routine actually thought/did last run.
      onClick={() => openRoutineRun(routine.id)}
    >
      <span className={`routine-tree-dot routine-dot-${status ?? 'none'}`} title={dotTitle} />
      <span className="routine-tree-cadence">{cadenceLabel(routine.intervalMs)}</span>
      {activity ? (
        <span className="routine-tree-prompt routine-tree-activity">{activity}</span>
      ) : (
        <span className="routine-tree-prompt">{routine.prompt}</span>
      )}
      <button
        className="routine-tree-run"
        title="Run now"
        onClick={(e) => {
          e.stopPropagation()
          window.cove.routinesRunNow(routine.id)
          openRoutineRun(routine.id) // open the viewer so the run is visible live
        }}
      >
        ▶
      </button>
    </div>
  )
}

/** One conversation under a project. Double-click the title to rename it. */
function ChatRow({
  chat,
  workspaceId,
  active,
  onOpen
}: {
  chat: Chat
  workspaceId: string
  active: boolean
  onOpen: () => void
}): React.JSX.Element {
  const renameChat = useStore((s) => s.renameChat)
  const removeChat = useStore((s) => s.removeChat)
  const unread = useStore((st) => Boolean(st.unread[chat.id]))
  // The spinner means "this conversation's turn is running", per chat, on screen
  // or not. Deliberately NOT keyed on background commands: a lingering `xcodebuild`
  // shows as its own pill, and letting it spin the sidebar made a finished chat
  // look like it was still thinking. (Background tasks still keep the chat mounted
  // — that's a separate concern in WorkspaceView.)
  const running = useStore((st) => Boolean(st.busy[chat.id]?.generating))
  const [editing, setEditing] = useState(false)
  const label = chat.title ?? 'New chat'
  const [draft, setDraft] = useState(label)

  return (
    <div
      className={`routine-tree-row chat-tree-row ${active ? 'selected' : ''} ${
        unread ? 'unread' : ''
      }`}
      title={label}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        window.cove.chatMenu(chat.id, workspaceId, chat.cwd)
      }}
      onDoubleClick={() => {
        setDraft(label)
        setEditing(true)
      }}
    >
      {editing ? (
        <input
          className="sidebar-item-rename chat-tree-rename"
          value={draft}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = draft.trim()
            if (n && n !== label) renameChat(workspaceId, chat.id, n)
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(label)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="chat-tree-title">
          {running ? (
            <span className="chat-tree-spinner" title="Working…" />
          ) : (
            unread && (
              <span className="sidebar-unread" title="Claude finished — you haven't read this" />
            )
          )}
          {label}
          {chat.cwd && (
            <span className="chat-tree-wt" title={`Worktree: ${chat.cwd}`}>
              ⎇ {chat.cwd.split('/').pop()}
            </span>
          )}
        </span>
      )}
      <button
        className="routine-tree-run chat-tree-remove"
        title="Delete this chat"
        onClick={(e) => {
          e.stopPropagation()
          removeChat(workspaceId, chat.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

function WorkspaceRow({ ws, index }: { ws: Workspace; index: number }): React.JSX.Element {
  const active = useStore((s) => s.activeWorkspaceId === ws.id && s.overlay === null)
  // Live only — no localStorage fallback. What was remembered is "the pane was
  // open here once", which kept showing a phone long after the device had been
  // shut down.
  const simHere = useStore((s) => s.simOpen[ws.id] ?? false)
  const status = useStore((s) => s.statuses[ws.id] ?? 'idle')
  const agentLive = useStore((s) => Boolean(s.agentLive[ws.id]))
  // A live dev server on this project → green dot on its icon (mirrors the
  // toolbar's "● localhost:PORT" chip).
  const serverPorts = useStore((s) => s.ports[ws.id] ?? EMPTY_PORTS)
  /**
   * A page is attached to this project's session — whatever opened it.
   *
   * The green dot only ever meant "the agent started a dev server here", so a
   * project sitting on a live site it did not start showed nothing at all. The
   * question the row should answer is what this project currently has on
   * screen, not who is responsible for it.
   */
  // Live only, reported by the pane itself. What is remembered is "a page was
  // open here once", which is the same mistake the simulator badge made.
  const pageUrl = useStore((s) => (ws.kind !== 'browser' ? (s.pageUrl[ws.id] ?? '') : ''))
  const pageHere = Boolean(pageUrl)
  const routines = useStore((s) => s.routines[ws.id] ?? EMPTY_ROUTINES)
  const chats = useStore((s) => s.chats[ws.id] ?? EMPTY_CHATS)
  /**
   * Something finished here that you have not read. Shown on the project too,
   * because a collapsed project is exactly when you would otherwise miss it.
   */
  const unread = useStore((s) => s.unread)
  const unreadHere = chats.some((c) => unread[c.id])
  const activeChatId = useStore((s) => s.activeChatId[ws.id])
  const selectChat = useStore((s) => s.selectChat)
  const setActive = useStore((s) => s.setActive)
  const browsingHere = useStore((s) => s.browsingWorkspaceId === ws.id)
  const removeWorkspace = useStore((s) => s.removeWorkspace)

  // Git repos nested inside a code project's folder (a folder-of-repos), shown
  // tree-style under it. Refreshed after Claude's turns (branches/repos change).
  const [subrepos, setSubrepos] = useState<{ name: string; path: string; branch: string | null }[]>(
    []
  )
  const [selfBranch, setSelfBranch] = useState<string | null>(null) // branch if the project folder is itself a repo
  const [aheadBehind, setAheadBehind] = useState<{ ahead: number; behind: number } | null>(null)
  const [reposOpen, setReposOpen] = useState(false) // collapsed by default
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null) // step 1 of 2
  const openFolderAsProject = useStore((s) => s.openFolderAsProject)

  // For a default-named browser project, label the row with the site it's on, and
  // show its favicon instead of the generic globe. The favicon (a data: URI) is
  // cached in localStorage so it's already there on the next launch, before the
  // pane reloads and re-emits it.
  const [siteUrl, setSiteUrl] = useState(ws.browserUrl ?? '')
  const [favicon, setFavicon] = useState<string>(
    () => localStorage.getItem(`favicon:${ws.id}`) ?? ''
  )
  useEffect(() => {
    if (ws.kind !== 'browser') return
    return window.cove.onBrowserState(ws.id, (s) => {
      if (s.url) setSiteUrl(s.url)
      if (s.favicon && s.favicon !== favicon) {
        setFavicon(s.favicon)
        localStorage.setItem(`favicon:${ws.id}`, s.favicon)
      }
    })
  }, [ws.kind, ws.id, favicon])
  const displayName =
    ws.kind === 'browser' && ws.name === 'Browser project'
      ? hostOfUrl(siteUrl) || ws.name
      : ws.name
  useEffect(() => {
    if (ws.kind === 'browser') return
    let alive = true
    const refresh = (): void => {
      window.cove.gitSubrepos(ws.path).then((s) => {
        if (alive) setSubrepos(s)
      })
      window.cove.gitBranch(ws.path).then((b) => {
        if (alive) setSelfBranch(b)
      })
      window.cove.gitAheadBehind?.(ws.path).then((ab) => {
        if (alive) setAheadBehind(ab)
      })
    }
    refresh()
    const onIdle = (e: Event): void => {
      if ((e as CustomEvent<{ workspaceId: string }>).detail?.workspaceId === ws.id) refresh()
    }
    window.addEventListener('cove:workspace-idle', onIdle)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', onIdle)
    }
  }, [ws.kind, ws.path, ws.id])

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: ws.id,
    data: { index, groupId: ws.groupId }
  })
  // Also a drop target, so dragging over a row lets us reorder relative to it
  // (not just append to the group).
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: ws.id })
  const setRefs = (node: HTMLElement | null): void => {
    setNodeRef(node)
    setDropRef(node)
  }

  return (
    <div className="sidebar-item-wrap">
      <div
        ref={setRefs}
        className={`sidebar-item ${active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isOver ? 'drop-before' : ''}`}
        onClick={() => {
          window.dispatchEvent(new CustomEvent('cove:close-dashboard'))
          setActive(ws.id)
        }}
        onContextMenu={(e) => {
          // Browser tabs have no folder to branch; the menu is a code-project thing.
          if (ws.kind === 'browser') return
          e.preventDefault()
          // selfBranch !== null means the folder is itself a git repo → worktree
          // chats are possible.
          window.cove.workspaceMenu({ id: ws.id, path: ws.path, isRepo: selfBranch !== null })
        }}
        {...attributes}
        {...listeners}
      >
        <StatusDot status={status} live={agentLive} browsing={browsingHere} />
        <span
          className="sidebar-item-kind"
          title={
            simHere
              ? 'A simulator is attached to this project'
              : ws.kind === 'browser'
                ? 'Browser'
                : 'Folder'
          }
        >
          {ws.kind === 'browser' && favicon ? (
            <img
              className="sidebar-favicon"
              src={favicon}
              alt=""
              // A favicon that fails to render falls back to the globe icon.
              onError={() => setFavicon('')}
            />
          ) : simHere ? (
            <PhoneIcon />
          ) : (
            <KindIcon kind={ws.kind} />
          )}
          {/* The dot means "something of this project's is live right now". A
              dev server counted and an attached simulator did not, so a project
              running a phone looked as idle as one running nothing. */}
          {(serverPorts.length > 0 || simHere) && (
            <span
              className="sidebar-server-dot"
              title={
                serverPorts.length > 0 && simHere
                  ? `Simulator attached · dev server on :${serverPorts.join(', :')}`
                  : simHere
                    ? 'A simulator is attached to this project'
                    : `Dev server on :${serverPorts.join(', :')}`
              }
            />
          )}
          {/* A live page, when there is no dev server to report: the dot is the
              more specific claim, so it wins the corner. */}
          {pageHere && serverPorts.length === 0 && !simHere && (
            <span className="sidebar-web-dot" title={pageBadge(pageUrl).title}>
              {pageBadge(pageUrl).icon}
            </span>
          )}
        </span>
        {/* Not editable: the name mirrors the folder, and renaming here changed
            only the label — which read as if it would move or rename the folder. */}
        <span className="sidebar-item-name" title={ws.path}>
          {displayName}
        </span>
        {unreadHere && !active && (
          <span className="sidebar-unread" title="Claude finished something you haven't read" />
        )}
        {selfBranch && <BranchChip branch={selfBranch} />}
        {/* Something to pull (behind upstream) and/or push (ahead), from the last
            fetch — a quiet ↓/↑ badge so you know the branch has drifted. */}
        {aheadBehind && aheadBehind.behind > 0 && (
          <span
            className="sidebar-item-git behind"
            title={`${aheadBehind.behind} commit${aheadBehind.behind === 1 ? '' : 's'} to pull (behind upstream, as of last fetch)`}
          >
            ↓{aheadBehind.behind}
          </span>
        )}
        {aheadBehind && aheadBehind.ahead > 0 && (
          <span
            className="sidebar-item-git ahead"
            title={`${aheadBehind.ahead} commit${aheadBehind.ahead === 1 ? '' : 's'} to push (ahead of upstream)`}
          >
            ↑{aheadBehind.ahead}
          </span>
        )}
        {/* The running-server chip lives in the workspace toolbar now (more room);
            the sidebar row was too cramped next to the branch + close button. */}
        <button
          className="sidebar-item-remove"
          title="Remove from SuperAgent"
          onClick={(e) => {
            e.stopPropagation()
            removeWorkspace(ws.id)
          }}
        >
          ×
        </button>
      </div>
      {subrepos.length > 0 && (
        <div className="routine-tree">
          <button
            className="repo-tree-toggle"
            onClick={() => setReposOpen((v) => !v)}
            aria-expanded={reposOpen}
          >
            <span
              className="repo-tree-caret"
              style={{ transform: reposOpen ? 'none' : 'rotate(-90deg)' }}
            >
              <Chevron size={12} />
            </span>
            {subrepos.length} repos
          </button>
          {reposOpen &&
            subrepos.map((r) => (
              <div
                key={r.path}
                className={`routine-tree-row repo-tree-row ${selectedRepo === r.path ? 'selected' : ''}`}
                title={r.path}
                // Step 1: select. Step 2: the revealed "Start session" button opens it.
                onClick={() => setSelectedRepo((cur) => (cur === r.path ? null : r.path))}
              >
                <span className="repo-tree-icon">
                  <KindIcon kind="code" size={12} />
                </span>
                <span className="routine-tree-prompt">{r.name}</span>
                {r.branch && selectedRepo !== r.path && (
                  <span className="repo-tree-branch">⎇ {r.branch}</span>
                )}
                {selectedRepo === r.path && (
                  <button
                    className="repo-tree-open"
                    onClick={(e) => {
                      e.stopPropagation()
                      openFolderAsProject(ws.groupId, r.name, r.path)
                      setSelectedRepo(null)
                    }}
                  >
                    Start session →
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
      {/* A project holds many conversations; show them only once there's a
          choice to make, so a single-chat project stays as quiet as before. */}
      {chats.length > 1 && (
        <div className="routine-tree">
          {chats.map((c) => (
            <ChatRow
              key={c.id}
              chat={c}
              workspaceId={ws.id}
              // Selected only when this PROJECT is the active one too — every
              // workspace remembers its own last chat, so without the guard each
              // project keeps a stuck-looking highlight after you move elsewhere.
              active={active && c.id === activeChatId}
              onOpen={() => {
                window.dispatchEvent(new CustomEvent('cove:close-dashboard'))
                setActive(ws.id)
                selectChat(ws.id, c.id)
              }}
            />
          ))}
        </div>
      )}
      {routines.length > 0 && (
        <div className="routine-tree">
          {routines.map((r) => (
            <RoutineRow key={r.id} routine={r} />
          ))}
        </div>
      )}
    </div>
  )
}

function GroupSection({
  group
}: {
  group: ReturnType<typeof useStore.getState>['tree'][number]
}): React.JSX.Element {
  const toggleCollapse = useStore((s) => s.toggleCollapse)
  const renameGroup = useStore((s) => s.renameGroup)
  const deleteGroup = useStore((s) => s.deleteGroup)
  const addWorkspace = useStore((s) => s.addWorkspace)
  const groupCount = useStore((s) => s.tree.length)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const { setNodeRef, isOver } = useDroppable({ id: `group:${group.id}` })
  // Drag the group header to reorder groups (id prefixed so onDragEnd can tell a
  // group drag from a project drag).
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging
  } = useDraggable({ id: `gdrag:${group.id}` })
  const collapsed = group.collapsed === 1

  const onDelete = (): void => {
    const n = group.workspaces.length
    const msg =
      n > 0
        ? `Delete the group "${group.name}"? Its ${n} project${n > 1 ? 's' : ''} will move to another group (not deleted).`
        : `Delete the empty group "${group.name}"?`
    if (window.confirm(msg)) deleteGroup(group.id)
  }

  return (
    <div
      className={`sidebar-group ${isOver ? 'drop-target' : ''} ${isDragging ? 'dragging' : ''}`}
      ref={setNodeRef}
    >
      <div className="sidebar-group-header">
        <button
          className="group-caret"
          onClick={() => toggleCollapse(group.id, !collapsed)}
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
          aria-label={collapsed ? 'Expand group' : 'Collapse group'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <Chevron size={13} />
        </button>
        {editing ? (
          <input
            className="group-name-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              renameGroup(group.id, name || group.name)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                renameGroup(group.id, name || group.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <span
            className="sidebar-group-title"
            ref={setDragRef}
            {...attributes}
            {...listeners}
            onDoubleClick={() => setEditing(true)}
            title="Drag to reorder · double-click to rename"
          >
            {group.name}
          </span>
        )}
        {groupCount > 1 && (
          <button
            className="group-delete"
            title="Delete group"
            aria-label="Delete group"
            onClick={onDelete}
          >
            ×
          </button>
        )}
        <button
          className="group-add"
          title="New project"
          aria-label="New project"
          onClick={() => addWorkspace(group.id)}
        >
          +
        </button>
      </div>
      {!collapsed && (
        <div className="sidebar-group-items">
          {group.workspaces.map((ws, i) => (
            <WorkspaceRow key={ws.id} ws={ws} index={i} />
          ))}
          {group.workspaces.length === 0 && (
            <button className="group-empty" onClick={() => addWorkspace(group.id)}>
              Add a project…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// The reserved group holding quick browser tabs — rendered as its own section
// at the top, never as a normal (renamable/deletable) group.
const TABS_GROUP = '__tabs'

export function Sidebar(): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const overlay = useStore((s) => s.overlay)
  const refresh = useStore((s) => s.refresh)
  const addGroup = useStore((s) => s.addGroup)
  const setActive = useStore((s) => s.setActive)
  const tabsGroup = tree.find((g) => g.name === TABS_GROUP)

  const newTab = async (): Promise<void> => {
    // Opening a tab shouldn't require choosing a project type first — that's
    // the whole point of the section.
    let gid = tabsGroup?.id
    if (!gid) {
      const next = await window.cove.createGroup(TABS_GROUP)
      gid = next.find((g) => g.name === TABS_GROUP)?.id
    }
    if (!gid) return
    const created = await window.cove.createBrowserWorkspace(gid, 'New Tab')
    // A tab is a browser first — open it filling the pane, not in the simulated
    // desktop card (that's for previewing sites at devices, not for browsing).
    localStorage.setItem(`viewport:${created.workspaceId}`, 'none')
    await refresh()
    setActive(created.workspaceId)
  }
  const moveWorkspace = useStore((s) => s.moveWorkspace)
  const moveGroup = useStore((s) => s.moveGroup)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useEffect(() => {
    refresh()
  }, [refresh])

  const onDragEnd = (e: DragEndEvent): void => {
    const activeId = String(e.active.id)
    const overId = e.over?.id ? String(e.over.id) : null
    if (!overId || overId === activeId) return

    const locate = (id: string): { groupId: string; index: number } | null => {
      for (const g of tree) {
        const index = g.workspaces.findIndex((w) => w.id === id)
        if (index >= 0) return { groupId: g.id, index }
      }
      return null
    }

    // Reordering a whole group (dragged the group header).
    if (activeId.startsWith('gdrag:')) {
      const gid = activeId.slice('gdrag:'.length)
      const targetGroupId = overId.startsWith('group:')
        ? overId.slice('group:'.length)
        : (locate(overId)?.groupId ?? null)
      if (!targetGroupId || targetGroupId === gid) return
      const srcIndex = tree.findIndex((g) => g.id === gid)
      const dstIndex = tree.findIndex((g) => g.id === targetGroupId)
      moveGroup(gid, srcIndex < dstIndex ? dstIndex - 1 : dstIndex)
      return
    }

    const src = locate(activeId)
    if (!src) return

    // Dropped on a group's empty area → append to that group.
    if (overId.startsWith('group:')) {
      const toGroupId = overId.slice('group:'.length)
      const group = tree.find((g) => g.id === toGroupId)
      moveWorkspace(activeId, toGroupId, group?.workspaces.length ?? 0)
      return
    }

    // Dropped on a specific row → insert before it. When reordering down within
    // the same group, removing the item first shifts the target left by one.
    const dst = locate(overId)
    if (!dst) return
    const sameGroup = dst.groupId === src.groupId
    const toIndex = sameGroup && src.index < dst.index ? dst.index - 1 : dst.index
    moveWorkspace(activeId, dst.groupId, toIndex)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-drag-region" />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="sidebar-scroll">
          <button
            className={`sidebar-dash-row ${overlay === 'computer' ? 'on' : ''}`}
            onClick={() => window.dispatchEvent(new CustomEvent('cove:open-computer'))}
          >
            <svg
              className="sidebar-dash-icon"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            >
              <rect x="1.5" y="2.5" width="13" height="9" rx="1.2" />
              <path d="M6 14h4" />
            </svg>
            Computer
          </button>
          <div className="sidebar-group">
            <div className="sidebar-group-head tabs-head">
              <span className="sidebar-group-title">Browse</span>
              <button className="group-add" title="New tab" onClick={() => void newTab()}>
                +
              </button>
            </div>
            {(tabsGroup?.workspaces ?? []).map((ws, i) => (
              <WorkspaceRow key={ws.id} ws={ws} index={i} />
            ))}
            {(tabsGroup?.workspaces ?? []).length === 0 && (
              // Was "Click + to browse" — grey text aiming you at a control an
              // inch away. It opens the tab itself now.
              <button className="tabs-empty" onClick={() => void newTab()}>
                Open a tab to browse
              </button>
            )}
          </div>
          {tree
            .filter((g) => g.name !== TABS_GROUP)
            .map((group) => (
              <GroupSection key={group.id} group={group} />
            ))}
        </div>
      </DndContext>
      <div className="sidebar-footer">
        <button className="sidebar-add-group" onClick={() => addGroup()}>
          + New group
        </button>
        <button
          className="sidebar-settings"
          title="Settings"
          onClick={() => window.dispatchEvent(new CustomEvent('cove:open-settings'))}
        >
          ⚙
        </button>
        <button
          className="sidebar-settings"
          title="Hide sidebar (⌘\)"
          onClick={() => window.dispatchEvent(new CustomEvent('cove:toggle-sidebar'))}
        >
          ⇤
        </button>
      </div>
    </aside>
  )
}
