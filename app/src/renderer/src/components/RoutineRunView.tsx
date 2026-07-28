import { useMemo } from 'react'
import type { Routine, RoutineStep } from '../../../preload'
import { useStore } from '../state'
import { SlideOverPanel } from './SlideOverPanel'
import { Markdown } from './Markdown'

function parseSteps(json: string | null): RoutineStep[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as RoutineStep[]) : []
  } catch {
    return []
  }
}

function cadence(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `every ${min} min`
  const h = Math.round(min / 60)
  return h === 1 ? 'every hour' : h < 24 ? `every ${h} hours` : `every ${Math.round(h / 24)} days`
}

function whenLabel(r: Routine): string {
  if (r.lastRunStatus === 'running') return 'Running now…'
  if (!r.lastRunAt) return 'Not run yet'
  const secsAgo = Math.round((Date.now() - r.lastRunAt) / 1000)
  if (secsAgo < 60) return 'Last run just now'
  const mins = Math.round(secsAgo / 60)
  if (mins < 60) return `Last run ${mins} min ago`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `Last run ${hrs}h ago` : `Last run ${Math.round(hrs / 24)}d ago`
}

/** Read-only view of what a routine did on its last run: thinking, tool calls, text. */
export function RoutineRunView(): React.JSX.Element | null {
  const openId = useStore((s) => s.openRoutineRunId)
  const routinesByWs = useStore((s) => s.routines)
  const close = useStore((s) => s.closeRoutineRun)
  const runNow = (id: string): void => window.cove.routinesRunNow(id)

  const routine = useMemo(() => {
    if (!openId) return null
    for (const list of Object.values(routinesByWs)) {
      const found = list.find((r) => r.id === openId)
      if (found) return found
    }
    return null
  }, [openId, routinesByWs])

  const steps = useMemo(() => parseSteps(routine?.lastRunTranscript ?? null), [routine])

  if (!openId) return null
  // The routine was deleted while its viewer was open — close gracefully.
  if (!routine) return null

  const running = routine.lastRunStatus === 'running'

  return (
    <SlideOverPanel title="Routine run" onClose={close}>
      <div className="routine-run-view">
        <div className="routine-run-head">
          <div className="routine-run-prompt">{routine.prompt}</div>
          <div className="routine-run-meta">
            <span>{cadence(routine.intervalMs)}</span>
            <span>·</span>
            <span className={`routine-run-status routine-run-status-${routine.lastRunStatus ?? 'none'}`}>
              {whenLabel(routine)}
            </span>
            <button className="routine-run-now" title="Run now" onClick={() => runNow(routine.id)}>
              ▶ Run now
            </button>
          </div>
          {routine.lastRunSummary && (
            <div className="routine-run-summary">{routine.lastRunSummary}</div>
          )}
        </div>

        {steps.length === 0 ? (
          <div className="routine-run-empty">
            {running
              ? 'Running now — the transcript will appear when this run finishes.'
              : "No transcript yet. This routine hasn't completed a run, or it produced no steps."}
          </div>
        ) : (
          <div className="routine-run-steps">
            {steps.map((step, i) => {
              if (step.kind === 'thinking') {
                return (
                  <div key={i} className="routine-step routine-step-thinking">
                    {step.text}
                  </div>
                )
              }
              if (step.kind === 'tool') {
                return (
                  <div key={i} className="routine-step routine-step-tool">
                    <span className="routine-step-tool-name">{step.name}</span>
                    {step.input && <span className="routine-step-tool-input">{step.input}</span>}
                  </div>
                )
              }
              return (
                <div key={i} className="routine-step routine-step-text">
                  <Markdown text={step.text} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </SlideOverPanel>
  )
}
