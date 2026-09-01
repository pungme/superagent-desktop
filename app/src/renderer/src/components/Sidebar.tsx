import { useEffect, useState } from 'react'
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  useDndContext
} from '@dnd-kit/core'
import { useStore, normalizeCwd, isPendingBranch, WorkspaceStatus } from '../state'
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
 * The branch chip, truncated in the row. On hover the SAME pill simply widens in
 * place to show the full name (max-width lifts, the row's name span gives way) —
 * no clone, no tooltip, nothing floating. A fixed-position "expansion" pinned
 * over the chip was tried and read as a popup: different background, a shadow,
 * and any misalignment showed both pills at once.
 */
function BranchChip({ branch }: { branch: string }): React.JSX.Element {
  return <span className="sidebar-item-branch">⎇ {branch}</span>
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
/**
 * One place to work: the branch on the left, the conversation happening in it
 * on the right. Double-click renames that conversation (and its branch follows),
 * right-click gives the chat's menu — or the branch's, when no chat has been
 * started in it yet. Rebuilding this as a plain button twice cost the rename
 * both times; it lives here so it cannot be dropped again.
 */
function BranchRow({
  branch,
  chat,
  workspaceId,
  nested,
  active,
  onOpen,
  onMenu,
  onRemove
}: {
  branch: string
  chat: Chat | undefined
  workspaceId: string
  nested: boolean
  active: boolean
  onOpen: () => void
  onMenu: () => void
  /** Delete this conversation. Asks about unkept work first — see removeChat. */
  onRemove?: () => void
}): React.JSX.Element {
  const renameChat = useStore((s) => s.renameChat)
  const running = useStore((st) => Boolean(chat && st.busy[chat.id]?.generating))
  const unread = useStore((st) => Boolean(chat && st.unread[chat.id]))
  const label = chat?.title ?? (chat ? 'New chat' : '')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  return (
    <div
      className={`sidebar-branch${nested ? ' nested' : ''}${active ? ' on' : ''}`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu()
      }}
      onDoubleClick={() => {
        if (!chat) return
        setDraft(label)
        setEditing(true)
      }}
      title={branch}
    >
      {/* The conversation is what you look for, so it reads first; the branch it
          runs in sits down the right. A row with no chat yet has nothing to put
          on the left, so the branch takes that place instead of leaving a gap. */}
      {!chat && <span className="sidebar-branch-glyph">⎇</span>}
      {!chat && <span className="sidebar-branch-name">{branch}</span>}
      {editing && chat ? (
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
        chat && (
          <span className="sidebar-branch-title">
            {running && <span className="chat-tree-spinner" title="Working…" />}
            {unread && !running && <span className="sidebar-unread" />}
            {label}
          </span>
        )
      )}
      {chat && (
        <span className="sidebar-branch-chat" title={branch}>
          ⎇ {branch}
        </span>
      )}
      {chat && onRemove && (
        <button
          className="sidebar-branch-remove"
          title="Delete this chat"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

function ChatRow({
  chat,
  workspaceId,
  active,
  onOpen,
  folderBranch
}: {
  chat: Chat
  workspaceId: string
  active: boolean
  onOpen: () => void
  /** The branch the PROJECT FOLDER is on, for a chat that has no copy of its
   *  own. Without it a chat working in the folder itself showed no branch at
   *  all, so you could not tell what it was about to change. */
  folderBranch?: string | null
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
  // Background work (a Monitor, a long job) keeps the session alive even when the
  // turn is over. Show a distinct STEADY dot for it — not the "working" spinner,
  // which reads as "still thinking" — so you can tell from the sidebar that this
  // session has something running (e.g. a monitor) even while you're in another.
  const bgRunning = useStore((st) => (st.busy[chat.id]?.background ?? 0) > 0)
  const [editing, setEditing] = useState(false)
  const label = chat.title ?? 'New chat'
  const [draft, setDraft] = useState(label)
  // The chip shows the branch the chat is actually ON (read from its HEAD), not
  // the folder slug — so it follows a title rename, and it follows the agent if
  // the user asks for a branch of their own. Re-read whenever a turn ends.
  const [wtBranch, setWtBranch] = useState<string | null>(null)
  useEffect(() => {
    if (!chat.cwd) return
    let alive = true
    const refresh = (): void => {
      window.cove.gitBranch(chat.cwd!).then((b) => {
        if (alive) setWtBranch(b)
      })
    }
    refresh()
    window.addEventListener('cove:workspace-idle', refresh)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', refresh)
    }
  }, [chat.cwd])

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
          ) : bgRunning ? (
            <span className="chat-tree-bg" title="Background work running (e.g. a monitor)" />
          ) : (
            unread && (
              <span className="sidebar-unread" title="Claude finished — you haven't read this" />
            )
          )}
          <span className="chat-tree-label">{label}</span>
          {!chat.cwd && isPendingBranch(chat.id) ? (
            /* Waiting for its first message. It is NOT on main — saying so would
               be a lie about where the agent is about to write. */
            <span className="chat-tree-wt pending" title="Its branch is cut when you send the first message">
              not started
            </span>
          ) : chat.cwd && !wtBranch ? (
            /* Its copy is gone — removed by hand, or the branch merged and
               reaped while the chat outlived it. Say so: rendering nothing made
               a dead chat look exactly like a live one on the folder itself,
               and a project full of them read as a list of identical rows. */
            <span className="chat-tree-wt gone" title={`Its copy is gone: ${chat.cwd}`}>
              copy gone
            </span>
          ) : (
            (chat.cwd ? wtBranch : folderBranch) && (
              <span
                className="chat-tree-wt"
                title={chat.cwd ? `Its own copy: ${chat.cwd}` : 'Your folder'}
              >
                ⎇ {(chat.cwd ? wtBranch : folderBranch)!.replace(/^superagent\//, '')}
              </span>
            )
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
  // The spinner used to trust the last Claude-Code hook status, last-write-wins.
  // But a background/worktree chat reaped on switch-away never fires its `Stop`
  // hook (and a trailing SubagentStop re-arms "working"), so it would spin
  // forever even though nothing is running. Derive "working" from the live
  // union of this workspace's chats' generating state instead — it clears on
  // turn-end AND on reap (clearBusy), so it can't strand. The hook is still the
  // source of truth for "needs-you" (a Notification the user must answer).
  const anyGenerating = useStore((s) =>
    (s.chats[ws.id] ?? []).some((c) => s.busy[c.id]?.generating)
  )
  const hookStatus = useStore((s) => s.statuses[ws.id] ?? 'idle')
  const status: WorkspaceStatus = anyGenerating
    ? 'working'
    : hookStatus === 'needs-you'
      ? 'needs-you'
      : 'idle'
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
   * The branches, straight from git rather than from what the app remembered:
   * the folder you opened first, then every extra checkout. A worktree made by
   * hand, or one whose chat was deleted, used to be invisible and unreachable —
   * now it is simply in the list. Re-read when a turn ends, since that is when
   * one is most likely to have appeared or gone.
   */
  const [worktrees, setWorktrees] = useState<
    { path: string; branch: string | null; main: boolean; base: string | null }[]
  >([])
  useEffect(() => {
    if (ws.kind === 'browser') return
    let alive = true
    const refresh = (): void => {
      window.cove.worktreeList(ws.path).then((list) => {
        if (alive) setWorktrees(list)
      })
      // Re-read the chats at the same moment. The two lists are compared against
      // each other to decide which branches have a conversation, so refreshing
      // one without the other is what made a branch with a chat look empty.
      void useStore.getState().loadChats(ws.id)
    }
    refresh()
    window.addEventListener('cove:workspace-idle', refresh)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', refresh)
    }
  }, [ws.path, ws.kind])
  const openBranch = useStore((s) => s.openBranch)
  const removeChatFn = useStore((s) => s.removeChat)
  /**
   * Something finished here that you have not read. Shown on the project too,
   * because a collapsed project is exactly when you would otherwise miss it.
   */
  // A boolean selector, not the whole unread map — subscribing to the map made
  // every project row re-render on any chat's read/unread flip anywhere.
  const unreadHere = useStore((s) => (s.chats[ws.id] ?? []).some((c) => Boolean(s.unread[c.id])))
  const activeChatId = useStore((s) => s.activeChatId[ws.id])
  /**
   * The project row is the folder's own conversation, so it highlights only
   * when THAT chat is the one on screen. Highlighting it whenever the project
   * was active lit it and a branch row at the same time, which read as two
   * things selected at once.
   */
  const rootSelected = useStore((s) => {
    if (s.activeWorkspaceId !== ws.id || s.overlay !== null) return false
    const id = s.activeChatId[ws.id]
    if (!id) return true
    const chat = s.chats[ws.id]?.find((c) => c.id === id)
    if (!chat) return true
    // A chat still waiting for its branch also has no cwd, so "no cwd" alone
    // made it look like the folder's own chat — and its row and this one both
    // lit up. Only a chat that will STAY in the folder counts as the root.
    return !chat.cwd && !isPendingBranch(chat.id)
  })
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
    ws.kind === 'browser' && ws.name === 'Browser project' ? hostOfUrl(siteUrl) || ws.name : ws.name
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
    // Also refresh when the app regains focus. Git can change outside this
    // project's chat — a pull/push from a terminal, another session, or another
    // machine — and nothing here would notice, so the ↓/↑ badge went stale (it
    // showed "6 to pull" after the branch was already synced). Re-checking on
    // focus makes it right the moment you come back to the window.
    const onFocus = (): void => refresh()
    window.addEventListener('cove:workspace-idle', onIdle)
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', onIdle)
      window.removeEventListener('focus', onFocus)
    }
  }, [ws.kind, ws.path, ws.id])

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: ws.id,
    data: { index, groupId: ws.groupId }
  })
  // Also a drop target, so dragging over a row lets us reorder relative to it
  // (not just append to the group).
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: ws.id })
  // While a whole GROUP is being dragged, rows must not show their insertion
  // line: closestCenter snaps to the nearest row, so an "insert between these
  // two projects" line appeared inside a folder and read as "drop the group
  // INTO this folder" — which groups never do. Hide it; the target folder shows
  // its own reorder line instead.
  const { active: dndActive } = useDndContext()
  const draggingGroup = String(dndActive?.id ?? '').startsWith('gdrag:')
  const setRefs = (node: HTMLElement | null): void => {
    setNodeRef(node)
    setDropRef(node)
  }

  return (
    <div className="sidebar-item-wrap">
      <div
        ref={setRefs}
        className={`sidebar-item ${rootSelected ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isOver && !draggingGroup ? 'drop-before' : ''}`}
        onClick={() => {
          window.dispatchEvent(new CustomEvent('cove:close-dashboard'))
          setActive(ws.id)
          // This row IS the conversation in the folder itself — the root chat.
          // It used to be repeated as a nested child of itself, which made the
          // root look like just another branch beneath it. A browser tab has no
          // folder to hold a chat.
          if (ws.kind !== 'browser') void openBranch(ws.id, null)
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
          title="Remove from Superagent"
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
      {/* The branches. Each one is a real git worktree: its own copy of the
          project on its own branch, able to run its own agent at the same time
          as the others. The first is the folder you opened — always present, so
          there is always a way back to it. A chat is how you talk to a branch,
          so they nest underneath, and only when there is a choice to make. */}
      {/* A folder that is not a repo has no branches to list — and cannot be
          given any. It still has conversations, so fall back to showing them
          plainly, exactly as before. Without this the whole block rendered
          null and a non-git project lost its chat list entirely. */}
      {worktrees.length === 0 && chats.length > 1 && (
        <div className="routine-tree">
          {chats.map((c) => (
            <ChatRow
              key={c.id}
              chat={c}
              workspaceId={ws.id}
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
      {/* The branch is the row; the conversation happening in it is the label
          on the right. main first, the branches cut from it indented beneath —
          one chat each, which is what a chat IS: a branch with someone talking
          to it. A chat that has not sent anything yet has no branch, so it sits
          at the end until its first message cuts one. */}
      {worktrees.length > 0 &&
        (() => {
          const chatOn = (wtPath: string | null): Chat | undefined =>
            chats.find(
              (c) =>
                !isPendingBranch(c.id) && normalizeCwd(c.cwd ?? null) === normalizeCwd(wtPath)
            )
          const pending = chats.filter((c) => isPendingBranch(c.id))
          // The folder's own chat lives on the project row now, so the list
          // below exists only for the extras: branches, chats waiting for one,
          // and chats whose copy has gone.
          const extras =
            worktrees.filter((w) => !w.main).length +
            pending.length +
            chats.filter(
              (c) =>
                !isPendingBranch(c.id) &&
                c.cwd &&
                !worktrees.some(
                  (w) => normalizeCwd(w.main ? null : w.path) === normalizeCwd(c.cwd ?? null)
                )
            ).length
          if (extras === 0) return null
          const row = (
            key: string,
            branch: string,
            chat: Chat | undefined,
            opts: {
              main?: boolean
              onOpen: () => void
              onMenu?: () => void
              onRemove?: () => void
            }
          ): React.JSX.Element => (
            <BranchRow
              key={key}
              branch={branch}
              chat={chat}
              workspaceId={ws.id}
              nested={!opts.main}
              active={Boolean(active && chat && chat.id === activeChatId)}
              onOpen={opts.onOpen}
              onMenu={opts.onMenu ?? ((): void => undefined)}
              onRemove={opts.onRemove}
            />
          )
          return (
            <div className="routine-tree">
              {worktrees
                .filter((wt) => !wt.main)
                .map((wt) => {
                const cwd = wt.main ? null : wt.path
                const chat = chatOn(cwd)
                return row(wt.path, wt.branch ?? 'detached', chat, {
                  main: wt.main,
                  onOpen: () => {
                    window.dispatchEvent(new CustomEvent('cove:close-dashboard'))
                    if (chat) {
                      setActive(ws.id)
                      selectChat(ws.id, chat.id)
                    } else {
                      openBranch(ws.id, cwd)
                    }
                  },
                  onRemove: chat ? () => void removeChatFn(ws.id, chat.id) : undefined,
                  onMenu: () => {
                    if (wt.main) return
                    if (chat) {
                      window.cove.chatMenu(chat.id, ws.id, chat.cwd)
                      return
                    }
                    window.cove.worktreeMenu({
                      projectPath: ws.path,
                      wtPath: wt.path,
                      branch: wt.branch,
                      base: wt.base
                    })
                  }
                })
              })}
              {/* Chats whose copy is gone — merged and reaped, or removed by
                  hand. They match no worktree and are not pending, so without a
                  row of their own they vanished from the sidebar entirely,
                  taking their transcript with them. */}
              {chats
                .filter(
                  (c) =>
                    !isPendingBranch(c.id) &&
                    c.cwd &&
                    !worktrees.some(
                      (w) => normalizeCwd(w.main ? null : w.path) === normalizeCwd(c.cwd ?? null)
                    )
                )
                .map((c) =>
                  row(c.id, 'copy gone', c, {
                    onOpen: () => {
                      window.dispatchEvent(new CustomEvent('cove:close-dashboard'))
                      setActive(ws.id)
                      selectChat(ws.id, c.id)
                    },
                    onRemove: () => void removeChatFn(ws.id, c.id),
                    onMenu: () => window.cove.chatMenu(c.id, ws.id, c.cwd)
                  })
                )}
              {pending.map((c) =>
                row(c.id, 'no branch yet', c, {
                  onOpen: () => {
                    window.dispatchEvent(new CustomEvent('cove:close-dashboard'))
                    setActive(ws.id)
                    selectChat(ws.id, c.id)
                  },
                  onRemove: () => void removeChatFn(ws.id, c.id),
                  onMenu: () => window.cove.chatMenu(c.id, ws.id, c.cwd)
                })
              )}
            </div>
          )
        })()}
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
  const { setNodeRef, isOver, active } = useDroppable({ id: `group:${group.id}` })
  // A group being dragged reorders groups — it never nests inside another. So its
  // drop hint is an insertion LINE, not the fill highlight a project-into-group
  // drop uses (that fill read as "drop into the middle of this group").
  const draggingGroup = String(active?.id ?? '').startsWith('gdrag:')
  // closestCenter usually resolves the hover to one of this group's ROWS, not the
  // group container, so `isOver` alone missed most of the group's body. Treat the
  // group as the drop target whenever the pointer is over its header OR any of its
  // projects — then the reorder line follows the folder you're actually over.
  const { over } = useDndContext()
  const overId = over ? String(over.id) : null
  const overThisGroup =
    overId === `group:${group.id}` || group.workspaces.some((w) => w.id === overId)
  // Drag the group header to reorder groups (id prefixed so onDragEnd can tell a
  // group drag from a project drag).
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging
  } = useDraggable({ id: `gdrag:${group.id}` })
  // Reorder line for a group drag over ANOTHER group; fill only for a project
  // dropped into a group. Never hint on the group being dragged itself.
  const showReorder = draggingGroup && overThisGroup && !isDragging
  const showFill = !draggingGroup && isOver
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
      className={`sidebar-group ${showReorder ? 'drop-reorder' : showFill ? 'drop-target' : ''} ${isDragging ? 'dragging' : ''}`}
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

/**
 * Every conversation on this Mac, newest first.
 *
 * No groups, no projects, no branches: where it lives is a subtitle here, not
 * the structure. The tree answers "where is that conversation"; this answers
 * "what happened while I was away", which is a different question and the one
 * you have more often.
 */
function ActivityList(): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const setActive = useStore((s) => s.setActive)
  const selectChat = useStore((s) => s.selectChat)
  const unread = useStore((s) => s.unread)
  const busy = useStore((s) => s.busy)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const [chats, setChats] = useState<Chat[]>([])

  // Reload whenever anything in the app says something moved — the same event
  // the sidebar already listens to for its own lists.
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.cove.chatListAll().then((all) => {
        if (alive) setChats(all)
      })
    }
    load()
    const onIdle = (): void => load()
    window.addEventListener('cove:workspace-idle', onIdle)
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', onIdle)
      clearInterval(t)
    }
  }, [])

  const names = new Map<string, string>()
  for (const g of tree) for (const w of g.workspaces) names.set(w.id, w.name)

  const recent = [...chats].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  return (
    <div className="sidebar-activity">
      {recent.length === 0 && <div className="activity-empty">Nothing here yet.</div>}
      {recent.map((c) => {
        const open = c.id === activeChatId[c.workspaceId] && c.workspaceId === activeWorkspaceId
        return (
          <button
            key={c.id}
            className={`activity-row ${open ? 'on' : ''}`}
            onClick={() => {
              window.dispatchEvent(new CustomEvent('cove:close-dashboard'))
              setActive(c.workspaceId)
              selectChat(c.workspaceId, c.id)
            }}
          >
            <span className={`activity-dot ${unread[c.id] ? 'unread' : ''}`} />
            <span className="activity-body">
              <span className="activity-top">
                <span className="activity-title">{c.title || 'New chat'}</span>
                {busy[c.id]?.generating && <span className="activity-live" />}
                <span className="activity-when">{when(c.updatedAt)}</span>
              </span>
              <span className="activity-where">{names.get(c.workspaceId) ?? ''}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** "4m", "2h", "yesterday" — a sidebar has no room for a date. */
function when(at?: number): string {
  if (!at) return ''
  const secs = Math.max(0, (Date.now() - at) / 1000)
  if (secs < 60) return 'now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`
  if (secs < 172_800) return 'yesterday'
  return `${Math.floor(secs / 86_400)}d`
}

export function Sidebar(): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const overlay = useStore((s) => s.overlay)
  const refresh = useStore((s) => s.refresh)
  const addGroup = useStore((s) => s.addGroup)
  const setActive = useStore((s) => s.setActive)
  const tabsGroup = tree.find((g) => g.name === TABS_GROUP)
  const [mode, setMode] = useState<'activity' | 'projects'>(
    () => (localStorage.getItem('cove.sidebarMode') === 'activity' ? 'activity' : 'projects')
  )
  useEffect(() => {
    localStorage.setItem('cove.sidebarMode', mode)
  }, [mode])

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
      {/* Two ways of reading the same Mac. Projects is where a conversation
          lives; Activity is what happened, newest first — which is the question
          you actually have after being away from the machine for an hour. The
          phone has had both for a while; this is the same pair. */}
      <div className="sidebar-modes" role="tablist" aria-label="Sidebar view">
        {(['activity', 'projects'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={`sidebar-mode ${mode === m ? 'on' : ''}`}
            onClick={() => setMode(m)}
          >
            {m === 'activity' ? 'Activity' : 'Projects'}
          </button>
        ))}
      </div>
      {mode === 'activity' && <ActivityList />}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="sidebar-scroll" style={mode === 'activity' ? { display: 'none' } : undefined}>
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
          {/* Chats, plain: the same conversations the Computer's Chat window
              holds, filling the content area with nothing else around them. */}
          <button
            className={`sidebar-dash-row ${overlay === 'chats' ? 'on' : ''}`}
            onClick={() => window.dispatchEvent(new CustomEvent('cove:open-chats'))}
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
              <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />
            </svg>
            Chats
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
