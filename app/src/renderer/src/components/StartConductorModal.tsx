import { useEffect, useState } from 'react'
import { useStore } from '../state'
import { openConductor } from '../lib/open-conductor'

/**
 * Starting a Conductor, in the app's own window (the plan's one-step modal): start clean, or bring
 * this project's existing chats under Main as its sessions.
 */
export function StartConductorModal({
  workspaceId,
  onClose
}: {
  workspaceId: string
  onClose: () => void
}): React.JSX.Element {
  const [existing, setExisting] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const name = useStore(
    (s) =>
      s.tree.flatMap((g) => g.workspaces).find((w) => w.id === workspaceId)?.name ?? 'this project'
  )
  const enter = useStore((s) => s.enterOverlay)
  const exit = useStore((s) => s.exitOverlay)
  useEffect(() => {
    enter()
    return () => exit()
  }, [enter, exit])
  useEffect(() => {
    void window.cove
      .chatList(workspaceId)
      .then((cs) => setExisting(cs.filter((c) => !c.incognito && c.title).map((c) => c.id)))
  }, [workspaceId])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const start = async (adopt: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    await window.cove.conductorEnable(workspaceId, adopt ? (existing ?? []) : [])
    await useStore.getState().refreshChats()
    onClose()
    await openConductor(workspaceId)
  }

  const n = existing?.length ?? 0
  return (
    <div className="sc-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sc-modal"
        role="dialog"
        aria-labelledby="sc-title"
        data-testid="start-conductor"
      >
        <div className="sc-mark" aria-hidden="true">
          <svg
            viewBox="0 0 16 16"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            <circle cx="3.5" cy="8" r="1.6" />
            <circle cx="12.5" cy="3.5" r="1.6" />
            <circle cx="12.5" cy="12.5" r="1.6" />
            <path d="M5 7.4C8 6.6 9 4.6 11 4M5 8.6c3 .8 4 2.8 6 3.4" />
          </svg>
        </div>
        <h2 id="sc-title">Start a Conductor for {name}</h2>
        <p className="sc-sub">
          One Main chat for this project. You keep writing to it; it starts a session for each piece
          of work on its own branch, sends your follow-ups to the right one, asks when it is not
          sure, and remembers what was decided.
        </p>
        <div className="sc-choices">
          <button
            className="sc-choice"
            onClick={() => void start(false)}
            disabled={busy}
            data-testid="start-clean"
          >
            <b>Start clean</b>
            <span>Main starts with no sessions. Your chats stay as they are.</span>
          </button>
          {n > 0 && (
            <button
              className="sc-choice"
              onClick={() => void start(true)}
              disabled={busy}
              data-testid="start-adopt"
            >
              <b>
                Connect the {n} existing {n === 1 ? 'chat' : 'chats'}
              </b>
              <span>They become Main&rsquo;s sessions, and Main gets a record of each.</span>
            </button>
          )}
        </div>
        <button className="sc-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
