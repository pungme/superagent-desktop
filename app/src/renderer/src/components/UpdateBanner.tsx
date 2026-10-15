import { useEffect, useRef, useState } from 'react'
import { useOverlayLock, useStore } from '../state'
import { Markdown } from './Markdown'

/**
 * Shown once a newer release has finished downloading in the background
 * (`update:ready` from the main-process auto-updater). Offers an immediate
 * restart-into-the-update; dismissing just hides the bar — the update still
 * installs on the next quit (autoInstallOnAppQuit).
 *
 * Installing quits the app, and quitting kills every agent, so a restart taken
 * mid-turn silently throws away whatever Claude was doing (and any command it
 * left running in the background). When something is in flight we ask first —
 * a confirmation rather than a disabled button, so a wedged agent can't hold the
 * update hostage. Either way the update still lands on the next quit.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [restartWhenIdle, setRestartWhenIdle] = useState(false)
  const [installing, setInstalling] = useState(false)
  // "What's new": notes are fetched lazily the first time you hover/click, and
  // cached in main. undefined = not loaded yet; null = fetched but none/failed.
  const [notes, setNotes] = useState<string | null | undefined>(undefined)
  const [notesHover, setNotesHover] = useState(false)
  const [notesPinned, setNotesPinned] = useState(false)
  const [notesLoading, setNotesLoading] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const busy = useStore((s) => s.busy)
  // The warning reaches down over the pane, and the pane is a native view
  // that paints above every bit of HTML: without this the choice sat behind a
  // PDF, its buttons out of reach. An overlay, like the lightbox and the
  // palette: the pane shows a still of itself and gets out of the way.
  useOverlayLock(confirming)
  const chats = useStore((s) => s.chats)
  const tree = useStore((s) => s.tree)
  const projectNames = new Map(tree.flatMap((g) => g.workspaces).map((w) => [w.id, w.name]))
  // The notes popover extends down over the desk, where the native browser/PDF
  // view paints above ALL HTML — without the overlay lock its lower half was
  // cut off by the page (checklist #1: every overlay near the pane takes the
  // lock). It freezes and detaches the native view while the notes are open.
  // Lives up here with the other hooks — this component has early returns.
  const enterOverlay = useStore((s) => s.enterOverlay)
  const exitOverlay = useStore((s) => s.exitOverlay)
  const notesOpen = notesHover || notesPinned
  useEffect(() => {
    if (!notesOpen) return
    enterOverlay()
    return () => exitOverlay()
  }, [notesOpen, enterOverlay, exitOverlay])

  const progress = useStore((s) => s.updateProgress)
  const entries = Object.values(busy)
  const workingChats = entries.filter((b) => b.generating).length
  const backgroundTasks = entries.reduce((n, b) => n + b.background, 0)
  const inFlight = workingChats > 0 || backgroundTasks > 0

  // A queued restart follows the same app-wide busy state as the warning. Keep
  // it in the renderer so cancelling is immediate and a new downloaded version
  // cannot inherit an old schedule. As soon as the final chat/task settles,
  // hand off to the updater exactly as an immediate restart would.
  useEffect(() => {
    if (!restartWhenIdle || inFlight || !version || installing) return
    const timer = window.setTimeout(() => {
      setRestartWhenIdle(false)
      setInstalling(true)
      window.cove.installUpdate()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [restartWhenIdle, inFlight, version, installing])

  useEffect(() => {
    const offReady = window.cove.onUpdateReady((v) => {
      setVersion(v)
      setDismissed(false)
      setConfirming(false)
      setRestartWhenIdle(false)
      useStore.setState({ updateProgress: null }) // downloading is over
    })
    const offProgress = window.cove.onUpdateProgress((p) => {
      useStore.setState({ updateProgress: p, updateError: null })
    })
    const offError = window.cove.onUpdateError((m) => {
      useStore.setState({ updateProgress: null, updateError: m })
    })
    return () => {
      offReady()
      offProgress()
      offError()
    }
  }, [])

  // Downloading: a quiet progress pill so the minute-plus between "found" and
  // "ready" isn't silent. Dismissable; the ready pill re-asserts itself.
  if (!version && progress && !dismissed) {
    return (
      <div className="update-banner" role="status">
        <span className="update-banner-dot" />
        <span className="update-banner-text">
          Downloading Superagent{progress.version ? ' ' : ''}
          <b>{progress.version ?? ''}</b> — {Math.round(progress.percent)}%
        </span>
        <button className="update-banner-close" onClick={() => setDismissed(true)} title="Hide">
          ×
        </button>
      </div>
    )
  }

  if (!version || dismissed) return null

  const install = (): void => {
    // The app takes a second or two to go down and hand over to the installer.
    // Without this the click looks like it did nothing — the exact complaint
    // that turned out to be a real failure underneath.
    setRestartWhenIdle(false)
    setInstalling(true)
    window.cove.installUpdate()
  }
  const onRestart = (): void => {
    if (inFlight) setConfirming(true)
    else install()
  }

  // Fetch the release body once, on first hover/click.
  const loadNotes = (): void => {
    if (notes !== undefined || notesLoading || !version) return
    setNotesLoading(true)
    window.cove
      .updateNotes(version)
      .then((n) => setNotes(n))
      .finally(() => setNotesLoading(false))
  }
  // Hover-intent: a short close delay bridges the gap between the trigger and the
  // popover below it, so moving the pointer down doesn't dismiss it.
  const openNotes = (): void => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setNotesHover(true)
    loadNotes()
  }
  const scheduleClose = (): void => {
    closeTimer.current = window.setTimeout(() => setNotesHover(false), 180)
  }
  const notesVisible = notesHover || notesPinned

  // "2 chats and 1 background task" — only naming what's actually running.
  const parts: string[] = []
  if (workingChats > 0) {
    parts.push(
      `Claude is still working in ${workingChats} ${workingChats === 1 ? 'chat' : 'chats'}`
    )
  }
  if (backgroundTasks > 0) {
    parts.push(
      `${backgroundTasks} background ${backgroundTasks === 1 ? 'task is' : 'tasks are'} running`
    )
  }
  const waitingParts: string[] = []
  if (workingChats > 0) {
    waitingParts.push(`${workingChats} active ${workingChats === 1 ? 'chat' : 'chats'}`)
  }
  if (backgroundTasks > 0) {
    waitingParts.push(`${backgroundTasks} background ${backgroundTasks === 1 ? 'task' : 'tasks'}`)
  }

  if (confirming) {
    // What exactly would be stopped, chat by chat, so the choice is an
    // informed one: "1 background task" could be a dev server nobody minds
    // losing or an hour-long job.
    const running = Object.entries(busy)
      .filter(([, b]) => b.generating || b.background > 0)
      .map(([chatId, b]) => {
        const chat = Object.values(chats)
          .flat()
          .find((c) => c.id === chatId)
        const project = chat ? projectNames.get(chat.workspaceId) : undefined
        return {
          chatId,
          title: [project, chat?.title ?? 'New chat'].filter(Boolean).join(' · '),
          workspaceId: chat?.workspaceId,
          items: [
            ...(b.generating ? [b.doing ?? 'The agent is replying'] : []),
            ...(b.what ?? []),
            // Counted but not named (an older view): still say it is there.
            ...Array.from(
              { length: Math.max(0, b.background - (b.what?.length ?? 0)) },
              () => 'A background task'
            )
          ]
        }
      })
    return (
      <div
        className="update-banner update-banner-warn update-banner-listed"
        role="alertdialog"
        aria-labelledby="update-confirm-title"
      >
        <div className="update-confirm-head">
          <span className="update-banner-dot update-banner-dot-warn" />
          <div className="update-confirm-words">
            <span id="update-confirm-title" className="update-confirm-title">
              {parts.join(' and ')}
            </span>
            <span className="update-confirm-sub">
              Restarting stops {workingChats + backgroundTasks === 1 ? 'it' : 'them'}.
            </span>
          </div>
        </div>
        {running.length > 0 && (
          <ul className="update-banner-running">
            {running.map((r) => (
              <li
                key={r.chatId}
                // A row is the way to the conversation: see for yourself before
                // deciding. The card goes; the update waits.
                role={r.workspaceId ? 'button' : undefined}
                tabIndex={r.workspaceId ? 0 : undefined}
                className={r.workspaceId ? 'update-banner-running-go' : undefined}
                title={r.workspaceId ? 'Open this conversation' : undefined}
                onClick={() => {
                  if (!r.workspaceId) return
                  const st = useStore.getState()
                  st.setActive(r.workspaceId)
                  st.selectChat(r.workspaceId, r.chatId)
                  setConfirming(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') (e.currentTarget as HTMLElement).click()
                }}
              >
                <span className="update-banner-running-head">
                  <span className="update-banner-running-chat">{r.title}</span>
                  {r.workspaceId && <span className="update-banner-running-open">Open ›</span>}
                </span>
                {r.items.map((it, i) => {
                  // "Terminal · cd …": the kind as a small tag, the rest as it is.
                  const cut = it.indexOf(' · ')
                  const kind = cut > 0 && cut <= 16 ? it.slice(0, cut) : null
                  const what = kind ? it.slice(cut + 3) : it
                  return (
                    <span key={i} className="update-banner-running-item">
                      {kind && (
                        <>
                          <span className="update-banner-running-kind">{kind}</span>
                          {/* Read as one line, "Editing · src/server.ts". */}
                          <span className="visually-hidden"> · </span>
                        </>
                      )}
                      <span
                        className={`update-banner-running-what ${kind === 'Terminal' ? 'mono' : ''}`}
                      >
                        {what.replace(/\s+/g, ' ')}
                      </span>
                    </span>
                  )
                })}
              </li>
            ))}
          </ul>
        )}
        <div className="update-confirm-actions">
          <button
            className="update-banner-ghost"
            // "Keep working" means "leave me alone", not "show me the other pill
            // again" — dismiss entirely; the update still installs on next quit.
            onClick={() => {
              setConfirming(false)
              setDismissed(true)
            }}
            title="Hide — the update installs on your next quit"
          >
            Keep working
          </button>
          <span className="update-confirm-spacer" />
          <button
            className="update-banner-secondary"
            onClick={() => {
              setConfirming(false)
              setRestartWhenIdle(true)
            }}
            title="Restart automatically after every active chat and background task finishes"
          >
            Restart when finished
          </button>
          <button className="update-banner-action update-banner-action-warn" onClick={install}>
            Restart anyway
          </button>
        </div>
      </div>
    )
  }

  if (restartWhenIdle) {
    return (
      <div className="update-banner update-banner-waiting" role="status">
        <span className="update-banner-dot update-banner-dot-waiting" />
        <span className="update-banner-text">
          Waiting for {waitingParts.join(' and ')}. Restarting automatically when finished.
        </span>
        <button className="update-banner-secondary" onClick={() => setRestartWhenIdle(false)}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-dot" />
      <span className="update-banner-text">
        Superagent <b>{version}</b> is ready to install.
      </span>
      <span className="update-notes-wrap" onMouseEnter={openNotes} onMouseLeave={scheduleClose}>
        <button
          className={`update-banner-whatsnew ${notesVisible ? 'on' : ''}`}
          onClick={() => setNotesPinned((p) => !p)}
          aria-expanded={notesVisible}
          title="What's new in this update"
        >
          What&rsquo;s new
        </button>
        {notesVisible && (
          <div className="update-notes" role="dialog" aria-label={`What's new in ${version}`}>
            <div className="update-notes-head">
              <span>What&rsquo;s new in {version}</span>
              <button
                className="update-notes-close"
                onClick={() => {
                  setNotesPinned(false)
                  setNotesHover(false)
                }}
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="update-notes-body">
              {notes ? (
                <Markdown text={notes} />
              ) : notesLoading ? (
                <span className="update-notes-muted">Loading…</span>
              ) : (
                <span className="update-notes-muted">Release notes unavailable.</span>
              )}
            </div>
          </div>
        )}
      </span>
      <button className="update-banner-action" onClick={onRestart} disabled={installing}>
        {installing ? 'Updating…' : 'Restart to update'}
      </button>
      <button
        className="update-banner-close"
        onClick={() => setDismissed(true)}
        title="Later (installs on next quit)"
      >
        ×
      </button>
    </div>
  )
}
