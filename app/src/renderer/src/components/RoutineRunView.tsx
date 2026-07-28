import { useMemo } from 'react'
import type { Routine, RoutineStep } from '../../../preload'
import { useStore } from '../state'
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

function formatTokens(n: number): string {
  if (n <= 0) return ''
  if (n < 1000) return `${n} tokens`
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k tokens`
}

function whenLabel(r: Routine): string {
  if (r.lastRunStatus === 'running') return 'Running now…'
  if (!r.lastRunAt) return 'Not run yet'
  const secsAgo = Math.round((Date.now() - r.lastRunAt) / 1000)
  if (secsAgo < 60) return 'ran just now'
  const mins = Math.round(secsAgo / 60)
  if (mins < 60) return `ran ${mins} min ago`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `ran ${hrs}h ago` : `ran ${Math.round(hrs / 24)}d ago`
}

/**
 * Live view of a routine's run, docked in the chat column so it reads like the
 * chat (tool chips + assistant bubbles). Streams in as the run works. Read-only —
 * it surfaces what the scheduled agent did; the run happens in an offscreen pane.
 */
export function RoutineRunView({ routine }: { routine: Routine }): React.JSX.Element {
  const close = useStore((s) => s.closeRoutineRun)
  const steps = useMemo(() => parseSteps(routine.lastRunTranscript), [routine.lastRunTranscript])
  const running = routine.lastRunStatus === 'running'
  const runs = routine.runCount === 1 ? '1 run' : `${routine.runCount} runs`
  const tokens = formatTokens(routine.lastRunTokens)

  return (
    <div className="routine-run-panel">
      <div className="routine-run-bar">
        <button className="routine-run-back" onClick={close} title="Back to chat">
          ‹
        </button>
        <span className="routine-run-bar-title">⏱ Routine run</span>
        <span
          className={`routine-run-bar-status routine-run-status-${routine.lastRunStatus ?? 'none'}`}
        >
          {whenLabel(routine)} · {runs}
          {tokens && !running ? ` · ${tokens}` : ''}
        </span>
        <button
          className="routine-run-bar-play"
          title="Run now"
          onClick={() => window.cove.routinesRunNow(routine.id)}
        >
          ▶
        </button>
      </div>

      <div className="routine-run-scroll">
        <div className="routine-run-promptcard">{routine.prompt}</div>

        {steps.length === 0 && !running && (
          <div className="routine-run-empty">
            No transcript yet. Press ▶ to run it, or wait for the next scheduled run.
          </div>
        )}

        {steps.map((step, i) => {
          if (step.kind === 'thinking') {
            return (
              <div key={i} className="routine-run-thinking">
                {step.text}
              </div>
            )
          }
          if (step.kind === 'tool') {
            return (
              <div key={i} className="easy-tools">
                <span className="easy-tool" title={step.input}>
                  <span className="easy-tool-icon">🌐</span>
                  <span className="easy-tool-verb">{step.name}</span>
                  {step.input && <span className="easy-tool-detail">{step.input}</span>}
                </span>
              </div>
            )
          }
          return (
            <div key={i} className="easy-msg easy-assistant routine-run-msg">
              <Markdown text={step.text} />
            </div>
          )
        })}

        {running && (
          <div className="routine-run-live">
            <span className="routine-run-live-dot" />
            {steps.length === 0 ? 'Starting the run…' : 'Running…'}
          </div>
        )}
      </div>
    </div>
  )
}
