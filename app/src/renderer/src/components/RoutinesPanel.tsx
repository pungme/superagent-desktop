import { useEffect, useState, useCallback } from 'react'
import type { Routine, Workspace } from '../../../preload'
import { useStore } from '../state'
import { SectionView } from './SectionView'

interface RoutinesPanelProps {
  ws: Workspace
  onClose: () => void
  /** Rendered inside a desktop window, which supplies the frame. */
  embedded?: boolean
}

function relativeInterval(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `every ${min} min`
  const h = Math.round(min / 60)
  return h === 1 ? 'every hour' : `every ${h} hours`
}

function statusLabel(r: Routine): string {
  const runs = r.runCount === 1 ? '1 run' : `${r.runCount} runs`
  const toks = r.lastRunTokens > 0 ? ` · ${Math.round(r.lastRunTokens / 1000)}k tokens` : ''
  if (r.lastRunStatus === 'running') return `Running now… · ${runs}`
  if (r.lastRunStatus === 'ok') return `Last run: ok · ${runs}${toks}`
  if (r.lastRunStatus === 'error') return `Last run: failed · ${runs}${toks}`
  return 'Not run yet'
}

export function RoutinesPanel({ ws, onClose, embedded = false }: RoutinesPanelProps): React.JSX.Element {
  const [routines, setRoutines] = useState<Routine[]>([])
  const [prompt, setPrompt] = useState('')
  const [hours, setHours] = useState(1)
  const openRoutineRun = useStore((s) => s.openRoutineRun)

  const refresh = useCallback(async () => {
    setRoutines(await window.cove.routinesList(ws.id))
  }, [ws.id])

  useEffect(() => {
    // setState lives inside the promise callback (not the synchronous effect body).
    window.cove.routinesList(ws.id).then(setRoutines)
    const off = window.cove.onRoutinesChanged(refresh)
    return off
  }, [ws.id, refresh])

  const create = async (): Promise<void> => {
    if (!prompt.trim()) return
    await window.cove.routinesCreate(ws.id, ws.path, prompt.trim(), hours * 60)
    setPrompt('')
    refresh()
  }

  return (
    <SectionView title="Routines" onClose={onClose} embedded={embedded}>
      <div className="routine-new">
        <textarea
          className="routine-prompt"
          placeholder="e.g. Open the site and check the signup form still works"
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="routine-new-row">
          <label>
            Run every
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={1}>1 hour</option>
              <option value={2}>2 hours</option>
              <option value={4}>4 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>1 day</option>
            </select>
          </label>
          <button className="skills-action routine-add" onClick={create} disabled={!prompt.trim()}>
            Add routine
          </button>
        </div>
      </div>

      <div className="skills-list">
        {routines.length === 0 && (
          <div className="skills-empty">
            <p>No routines yet. Add one above, or just ask Claude to “check this every hour”.</p>
          </div>
        )}
        {routines.map((r) => (
          <div key={r.id} className="routine-item">
            <div className="routine-item-top">
              <span className={`routine-toggle ${r.enabled ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={r.enabled === 1}
                  onChange={(e) => window.cove.routinesSetEnabled(r.id, e.target.checked)}
                />
              </span>
              <span className="routine-cadence">{relativeInterval(r.intervalMs)}</span>
              <button
                className="routine-run"
                onClick={() => {
                  window.cove.routinesRunNow(r.id)
                  openRoutineRun(r.id) // show the live run in the chat column…
                  onClose() // …and close this panel so it isn't hidden behind it
                }}
                title="Run now"
              >
                ▶
              </button>
              <button
                className="routine-delete"
                onClick={() => window.cove.routinesDelete(r.id).then(() => refresh())}
                title="Delete"
              >
                ×
              </button>
            </div>
            <div className="routine-prompt-text">{r.prompt}</div>
            <div className={`routine-status routine-status-${r.lastRunStatus ?? 'none'}`}>
              {statusLabel(r)}
              {r.lastRunSummary && <span className="routine-summary"> — {r.lastRunSummary}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="skills-footer">
        <span className="routine-note">Routines run only while SuperAgent is open.</span>
      </div>
    </SectionView>
  )
}
