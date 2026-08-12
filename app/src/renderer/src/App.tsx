import { useCallback, useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { HookConsent } from './components/HookConsent'
import { PreviewToast } from './components/PreviewToast'
import { UpdateBanner } from './components/UpdateBanner'
import { IntroSplash } from './components/IntroSplash'
import { ComputerPanel } from './components/ComputerPanel'
import { Onboarding } from './components/Onboarding'
import { Settings } from './components/Settings'
import { useStore } from './state'

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 460
// Drag inside this and the gesture reads as "put it away" rather than "make it
// tiny" — a sidebar narrower than this can't show a project name anyway.
const SIDEBAR_COLLAPSE_AT = 150

/**
 * Drag handle on the sidebar's trailing edge. Long project and branch names get
 * truncated at the default width, so the width is user-set and persisted.
 * Dragging far enough left collapses it; double-click resets to the default.
 */
function SidebarResizer({ onCollapse }: { onCollapse: () => void }): React.JSX.Element {
  const apply = (px: number): void => {
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px))
    document.documentElement.style.setProperty('--sidebar-width', `${w}px`)
    localStorage.setItem('cove.sidebarWidth', String(w))
  }

  useEffect(() => {
    const saved = Number(localStorage.getItem('cove.sidebarWidth'))
    if (saved) apply(saved)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.documentElement.classList.remove('sidebar-resizing')
    }
    const move = (ev: PointerEvent): void => {
      if (ev.clientX < SIDEBAR_COLLAPSE_AT) {
        // End the drag first so the collapse animates instead of being pinned
        // by `sidebar-resizing`, which disables the transition.
        up()
        onCollapse()
        return
      }
      apply(ev.clientX)
    }
    document.body.style.cursor = 'col-resize'
    // The collapse animation must not apply to a live drag, or it lags the pointer.
    document.documentElement.classList.add('sidebar-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const reset = (): void => {
    document.documentElement.style.removeProperty('--sidebar-width')
    localStorage.removeItem('cove.sidebarWidth')
  }

  return (
    <div
      className="sidebar-resizer"
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      title="Drag to resize · double-click to reset"
    />
  )
}

function App(): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const startHookListener = useStore((s) => s.startHookListener)
  const startBrowsingListener = useStore((s) => s.startBrowsingListener)
  const startRoutinesListener = useStore((s) => s.startRoutinesListener)
  const allWorkspaces = tree.flatMap((g) => g.workspaces)
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('cove.onboarded') === '1')

  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('cove.sidebarCollapsed') === '1'
  )
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      localStorage.setItem('cove.sidebarCollapsed', v ? '0' : '1')
      return !v
    })
  }, [])
  const collapseSidebar = useCallback(() => {
    localStorage.setItem('cove.sidebarCollapsed', '1')
    setSidebarCollapsed(true)
  }, [])

  // ⌘\ from anywhere, plus the buttons in the sidebar footer and the titlebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('cove:toggle-sidebar', toggleSidebar)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('cove:toggle-sidebar', toggleSidebar)
    }
  }, [toggleSidebar])

  // The agent's open_file tool asks the app to display a file in-app (viewer for
  // text/markdown, pane for PDFs/images) instead of the OS default.
  useEffect(() => {
    return window.cove.onOpenFile(({ workspaceId, path }) => {
      // Agent-originated: open in that project WITHOUT switching the user to it.
      useStore.getState().openPath(workspaceId, path, false)
    })
  }, [])

  // The agent added a project (e.g. cloned a repo) — pull in the new tree and,
  // if it named one to activate, jump to it so it's ready to use.
  useEffect(() => {
    return window.cove.onProjectsChanged(async ({ activate }) => {
      await useStore.getState().refresh()
      if (activate) useStore.getState().setActive(activate)
    })
  }, [])

  // A worktree chat asked to be merged back (already confirmed in the native
  // dialog). Squash it in, then clean up the chat that pointed at the worktree.
  useEffect(() => {
    return window.cove.onChatMergeWorktree(async ({ chatId, workspaceId, projectPath, wtPath }) => {
      const chat = useStore.getState().chats[workspaceId]?.find((c) => c.id === chatId)
      const title = chat?.title?.trim()
      const message =
        title && title !== 'New chat' ? title : `Merge worktree ${wtPath.split('/').pop()}`
      const res = await window.cove.worktreeMerge(projectPath, wtPath, message)
      if (res.ok) {
        // The worktree folder is gone now, so the chat that lived in it can't
        // resume — remove it and land the user on the project.
        await useStore.getState().removeChat(workspaceId, chatId)
        useStore.getState().setActive(workspaceId)
      } else {
        const why: Record<string, string> = {
          'base-dirty':
            'The project has uncommitted changes — commit or stash them first, then merge.',
          conflict:
            'Merge conflict — resolve it in this chat, then try again. Nothing was changed.',
          nothing: 'Nothing to merge — this worktree has no new commits.',
          'not-worktree': "This chat isn't in a worktree.",
          error: res.detail || 'git failed.'
        }
        window.alert(why[res.reason] ?? 'Could not merge the worktree.')
      }
    })
  }, [])

  // Right-click actions on a project row (native menu built in main).
  useEffect(() => {
    return window.cove.onWorkspaceMenuAction(async ({ action, id, path }) => {
      const s = useStore.getState()
      if (action === 'new-chat') {
        s.setActive(id)
        await s.newChat(id)
      } else if (action === 'new-worktree') {
        s.setActive(id)
        const ok = await s.newChatInWorktree(id, path)
        // Only offered for repos, so this is the rare "git refused" case (e.g. no
        // commits yet, or a dirty index git won't branch from).
        if (!ok) {
          window.alert("Couldn't create a worktree — git refused (needs ≥1 commit).")
        }
      }
    })
  }, [])

  // Keep every opened workspace mounted so switching tabs never restarts its
  // session — only the active one is shown; the rest run hidden in the background.
  const [opened, setOpened] = useState<string[]>([])
  if (activeId && !opened.includes(activeId)) {
    // Adjust state during render (the documented React pattern) when a new
    // workspace becomes active — it's re-rendered immediately.
    setOpened([...opened, activeId])
  }
  const openedWorkspaces = opened
    .map((id) => allWorkspaces.find((w) => w.id === id))
    .filter((w): w is (typeof allWorkspaces)[number] => Boolean(w))
  const [settingsOpen, setSettingsOpen] = useState(false)
  // One source of truth: the sidebar highlights whichever of these is showing.
  const overlay = useStore((s) => s.overlay)
  const setOverlay = useStore((s) => s.setOverlay)
  const computerOpen = overlay === 'computer'
  // Once opened it stays in the tree; before that there is nothing to keep.
  const [computerEverOpened, setComputerEverOpened] = useState(false)
  if (computerOpen && !computerEverOpened) setComputerEverOpened(true)
  /** Any full-window section — all four cover the projects the same way. */
  const sectionOpen = overlay !== null
  useEffect(() => {
    // One value, so opening either inherently closes the other.
    const openComputer = (): void => setOverlay('computer')
    // These live on the desktop now. Show it, then let it raise the window —
    // after a tick, so a freshly mounted desktop is listening by then.
    const openOnDesktop = (app: 'dashboard' | 'skills' | 'routines') => (): void => {
      setOverlay('computer')
      setTimeout(
        () => window.dispatchEvent(new CustomEvent('cove:open-desktop-app', { detail: { app } })),
        60
      )
    }
    const open = openOnDesktop('dashboard')
    const openSkills = openOnDesktop('skills')
    const openRoutines = openOnDesktop('routines')
    // Picking anything in the sidebar leaves both.
    const close = (): void => setOverlay(null)
    window.addEventListener('cove:open-dashboard', open)
    window.addEventListener('cove:open-computer', openComputer)
    window.addEventListener('cove:open-skills', openSkills)
    window.addEventListener('cove:open-routines', openRoutines)
    window.addEventListener('cove:close-dashboard', close)
    return () => {
      window.removeEventListener('cove:open-skills', openSkills)
      window.removeEventListener('cove:open-routines', openRoutines)
      window.removeEventListener('cove:open-dashboard', open)
      window.removeEventListener('cove:open-computer', openComputer)
      window.removeEventListener('cove:close-dashboard', close)
    }
  }, [])

  // Chat row context-menu actions, confirmed in main where the native menu lives.
  useEffect(() => {
    const offClear = window.cove.onChatCleared(({ chatId, workspaceId }) => {
      // Wipe transcript + session; the open chat resets itself via this event.
      window.cove.chatSave(chatId, '[]')
      window.cove.chatUpdate(chatId, { claudeSessionId: null })
      window.dispatchEvent(
        new CustomEvent('cove:chat-cleared', { detail: { chatId, workspaceId } })
      )
    })
    const offDelete = window.cove.onChatDeleteRequest(({ chatId, workspaceId }) => {
      void useStore.getState().removeChat(workspaceId, chatId)
    })
    return () => {
      offClear()
      offDelete()
    }
  }, [])
  const addGroup = useStore((s) => s.addGroup)
  const addWorkspace = useStore((s) => s.addWorkspace)

  const applyTheme = useStore((s) => s.applyTheme)

  useEffect(() => {
    startHookListener()
    // Main owns the banner gate but the persisted preference lives here — push it
    // at startup so a pref set last run holds before any agent finishes.
    window.cove.setNotifyPrefs({
      done: localStorage.getItem('cove.notifyDone') !== '0',
      needsYou: localStorage.getItem('cove.notifyNeedsYou') !== '0'
    })
    startBrowsingListener()
    startRoutinesListener()
    // Dev-server chips: keep the ones still listening, drop the rest. On a
    // timer, not just at startup — a server that dies mid-session used to keep
    // a green chip that opened onto a connection-refused page.
    useStore.getState().verifyPorts()
    const portTimer = window.setInterval(() => void useStore.getState().verifyPorts(), 20000)
    const onFocusCheckPorts = (): void => void useStore.getState().verifyPorts()
    window.addEventListener('focus', onFocusCheckPorts)
    applyTheme()
    // Re-apply when the OS light/dark preference changes (matters for "System").
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme()
    mq.addEventListener('change', onChange)
    return () => {
      mq.removeEventListener('change', onChange)
      window.clearInterval(portTimer)
      window.removeEventListener('focus', onFocusCheckPorts)
    }
  }, [startHookListener, startBrowsingListener, startRoutinesListener, applyTheme])

  useEffect(() => {
    const openSettings = (): void => setSettingsOpen(true)
    window.addEventListener('cove:open-settings', openSettings)
    return () => window.removeEventListener('cove:open-settings', openSettings)
  }, [])

  // A file dropped anywhere but the chat's drop zone would otherwise navigate the
  // shell to that file. Swallow those drags so only the chat handles files.
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  useEffect(() => {
    return window.cove.onMenu((action) => {
      if (action === 'settings') setSettingsOpen(true)
      else if (action === 'new-group') addGroup()
      else if (action === 'new-project') {
        const firstGroup = useStore.getState().tree[0]
        if (firstGroup) addWorkspace(firstGroup.id)
      } else if (action === 'close-tab') {
        // Cmd+W. Closes the active browser tab — that's what it means in a
        // browser. On anything else it does nothing: it must never close the
        // window (which is what the old `close` role did, losing the whole app).
        const s = useStore.getState()
        const id = s.activeWorkspaceId
        const ws = id ? s.tree.flatMap((g) => g.workspaces).find((w) => w.id === id) : undefined
        if (ws?.kind === 'browser') void s.removeWorkspace(ws.id)
      } else {
        // skills / routines / toggle-preview are workspace-scoped; forward via window event
        window.dispatchEvent(new CustomEvent(`cove:menu-${action}`))
      }
    })
  }, [addGroup, addWorkspace])

  if (!onboarded) {
    return (
      <>
        <IntroSplash />
        <Onboarding
          onDone={() => {
            localStorage.setItem('cove.onboarded', '1')
            setOnboarded(true)
          }}
        />
      </>
    )
  }

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {/* Kept mounted while collapsed so the width can animate (and so the tree
          doesn't rebuild its expansion state on every toggle). */}
      <Sidebar />
      <SidebarResizer onCollapse={collapseSidebar} />
      {/* The Computer's own menubar is its top chrome and takes the drag
          region with it, so the 8px title strip would read as a gap above it. */}
      <main className={`content ${computerOpen ? 'computer' : ''}`}>
        {/* When the sidebar is hidden this strip grows to clear the traffic
            lights, which would otherwise sit on top of the content. */}
        <div className="content-titlebar">
          {sidebarCollapsed && (
            <button className="sidebar-show" onClick={toggleSidebar} title="Show sidebar (⌘\)">
              ⇥
            </button>
          )}
        </div>
        <HookConsent />
        {openedWorkspaces.length === 0 && !sectionOpen ? (
          <div className="empty-state">
            <div className="empty-state-inner">
              <h1>Welcome to SuperAgent</h1>
              <p>
                Add a project from the sidebar — a code folder or a browser project — to get
                started.
              </p>
            </div>
          </div>
        ) : (
          openedWorkspaces.map((ws) => (
            <div
              key={ws.id}
              className="workspace-host"
              style={{ display: ws.id === activeId && !sectionOpen ? 'flex' : 'none' }}
            >
              {/* visible also detaches the native browser view — it would
                  composite above the dashboard otherwise. */}
              <WorkspaceView ws={ws} visible={ws.id === activeId && !sectionOpen} />
            </div>
          ))
        )}
        {/* Mounted from the first time it is opened and hidden thereafter, the
            same as a workspace: unmounting it stopped the desktop chat's agent
            and tore down its browser tabs, so stepping out of the Computer for
            a moment threw away whatever was running in it. */}
        {computerEverOpened && (
          <div className="computer-host" style={{ display: computerOpen ? 'flex' : 'none' }}>
            <ComputerPanel visible={computerOpen} onClose={() => setOverlay(null)} />
          </div>
        )}
      </main>
      <PreviewToast />
      <UpdateBanner />
      <IntroSplash />
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

export default App
