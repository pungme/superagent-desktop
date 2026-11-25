import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Routine, RoutineRun } from '../../../preload'
import { useStore } from '../state'
import {
  attentionOrder,
  compactTokens,
  savingsFor,
  typicalRunTokens,
  weeklyTokens,
  type RunSample
} from '../../../shared/routine-cost'

/**
 * Every routine in one place, by project: what ran, what failed, what it costs.
 *
 * Routines run unattended, so without this they are only a row under a project
 * that you have to open to learn that one has been failing for a day. Failed
 * ones come first. Each routine can be changed here — its words and how often
 * it runs — and shows what a run costs, measured from its own runs, so slowing
 * one down says what it saves.
 */

const INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 60, label: 'hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: 'day' },
  { minutes: 10080, label: 'week' }
]

function intervalOptions(ms: number): { minutes: number; label: string }[] {
  const minutes = Math.round(ms / 60_000)
  if (INTERVALS.some((i) => i.minutes === minutes)) return INTERVALS
  // An interval an agent set up that is not one of the usual ones stays selectable.
  const label = minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} min`
  return [...INTERVALS, { minutes, label }].sort((a, b) => a.minutes - b.minutes)
}

function ago(ts: number | null, now: number): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

function inTime(ts: number, now: number): string {
  const s = Math.round((ts - now) / 1000)
  if (s <= 60) return 'soon'
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `in ${h} h`
  return `in ${Math.round(h / 24)} d`
}

const asSamples = (runs: RoutineRun[]): RunSample[] =>
  runs.filter((r) => r.status !== 'running').map((r) => ({ status: r.status, tokens: r.tokens }))

export function RoutinesOverview({ visible }: { visible: boolean }): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const openRoutineRun = useStore((s) => s.openRoutineRun)
  const setActive = useStore((s) => s.setActive)
  const [routines, setRoutines] = useState<Routine[]>([])
  const [runs, setRuns] = useState<Record<string, RoutineRun[]>>({})
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    const [list, all] = await Promise.all([window.cove.routinesList(), window.cove.routinesRuns()])
    const by: Record<string, RoutineRun[]> = {}
    for (const r of all) (by[r.routineId] ??= []).push(r)
    setRoutines(list)
    setRuns(by)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.cove.onRoutinesChanged(() => void refresh())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

  const projects = useMemo(() => {
    const names = new Map<string, string>()
    for (const g of tree) for (const w of g.workspaces) names.set(w.id, w.name)
    const by = new Map<string, Routine[]>()
    for (const r of routines) {
      const list = by.get(r.workspaceId) ?? []
      list.push(r)
      by.set(r.workspaceId, list)
    }
    return [...by.entries()]
      .map(([id, list]) => ({
        id,
        name: names.get(id) ?? 'Project',
        routines: attentionOrder(list)
      }))
      .sort(
        (a, b) =>
          Number(b.routines.some((r) => r.lastRunStatus === 'error')) -
            Number(a.routines.some((r) => r.lastRunStatus === 'error')) ||
          a.name.localeCompare(b.name)
      )
  }, [routines, tree])

  const failed = routines.filter((r) => r.lastRunStatus === 'error').length
  const running = routines.filter((r) => r.lastRunStatus === 'running').length
  const week = routines.reduce(
    (n, r) => n + (weeklyTokens(asSamples(runs[r.id] ?? []), r.intervalMs, r.enabled === 1) ?? 0),
    0
  )
  const unmeasured = routines.filter(
    (r) => r.enabled === 1 && typicalRunTokens(asSamples(runs[r.id] ?? [])) === null
  ).length

  if (!visible) return <></>
  return (
    <div className="rov" data-testid="routines-overview">
      <div className="rov-head">
        <h1>Routines</h1>
        <span className="rov-sub">
          {routines.length === 0
            ? 'Nothing scheduled'
            : [
                `${routines.length} ${routines.length === 1 ? 'routine' : 'routines'}`,
                failed ? `${failed} failed` : '',
                running ? `${running} running` : '',
                week > 0 ? `about ${compactTokens(week)} tokens a week` : ''
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </div>
      {unmeasured > 0 && (
        <div className="rov-note">
          {unmeasured === 1 ? 'One routine has' : `${unmeasured} routines have`} not run yet, so
          their cost is not known. Estimates come from real runs.
        </div>
      )}
      <div className="rov-body">
        {loaded && routines.length === 0 && (
          <div className="rov-empty">
            <p>No routines yet.</p>
            <p>
              Ask an agent to “check this every hour” and it appears here, with its runs and what
              they cost.
            </p>
          </div>
        )}
        {projects.map((p) => (
          <section key={p.id} className="rov-project">
            <h2>
              <button className="rov-project-name" onClick={() => setActive(p.id)}>
                {p.name}
              </button>
            </h2>
            {p.routines.map((r) => (
              <RoutineCard
                key={r.id}
                routine={r}
                runs={runs[r.id] ?? []}
                now={now}
                onOpenRun={() => {
                  // The run opens in its project's chat column, so go there first.
                  setActive(p.id)
                  openRoutineRun(r.id)
                }}
                onChanged={() => void refresh()}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

function RoutineCard({
  routine: r,
  runs,
  now,
  onOpenRun,
  onChanged
}: {
  routine: Routine
  runs: RoutineRun[]
  now: number
  onOpenRun: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(r.prompt)
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const samples = asSamples(runs)
  const typical = typicalRunTokens(samples)
  const week = weeklyTokens(samples, r.intervalMs, r.enabled === 1)
  const status = r.lastRunStatus
  const options = intervalOptions(r.intervalMs)
  const minutes = Math.round(r.intervalMs / 60_000)

  const savePrompt = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || text === r.prompt) {
      setEditing(false)
      setDraft(r.prompt)
      return
    }
    await window.cove.routinesUpdate(r.id, { prompt: text })
    setEditing(false)
    onChanged()
  }

  const changeInterval = async (to: number): Promise<void> => {
    const s = savingsFor(samples, r.intervalMs, to * 60_000)
    await window.cove.routinesUpdate(r.id, { intervalMinutes: to })
    setSaved(
      s && s.saved > 0
        ? `Saves about ${compactTokens(s.saved)} tokens a week`
        : s && s.saved < 0
          ? `Costs about ${compactTokens(-s.saved)} more tokens a week`
          : null
    )
    onChanged()
  }

  return (
    <div
      className={`rov-card ${r.enabled ? '' : 'paused'} rov-${status ?? 'none'}`}
      data-testid="routine-card"
      data-routine-id={r.id}
    >
      <div className="rov-card-top">
        <span className={`routine-tree-dot routine-dot-${status ?? 'none'}`} title={status ?? ''} />
        {editing ? (
          <textarea
            className="rov-edit"
            value={draft}
            rows={3}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false)
                setDraft(r.prompt)
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void savePrompt()
            }}
          />
        ) : (
          <button
            className="rov-prompt"
            title="Edit what it does"
            onClick={() => {
              setDraft(r.prompt)
              setEditing(true)
            }}
          >
            {r.prompt}
          </button>
        )}
        <label className="rov-toggle" title={r.enabled ? 'Pause' : 'Resume'}>
          <input
            type="checkbox"
            checked={r.enabled === 1}
            onChange={(e) => {
              void window.cove.routinesSetEnabled(r.id, e.target.checked).then(onChanged)
            }}
          />
        </label>
        <button
          className="rov-icon"
          title="Run now"
          disabled={status === 'running'}
          onClick={() => {
            window.cove.routinesRunNow(r.id)
            onOpenRun()
          }}
        >
          ▶
        </button>
        <button
          className="rov-icon"
          title="Delete"
          onClick={() => {
            if (!window.confirm(`Delete this routine?\n\n${r.prompt.slice(0, 140)}`)) return
            void window.cove.routinesDelete(r.id).then(onChanged)
          }}
        >
          ×
        </button>
      </div>
      {editing && (
        <div className="rov-edit-actions">
          <button className="rov-btn primary" onClick={() => void savePrompt()}>
            Save
          </button>
          <button
            className="rov-btn"
            onClick={() => {
              setEditing(false)
              setDraft(r.prompt)
            }}
          >
            Cancel
          </button>
          <span className="rov-hint">Applies from the next run · ⌘↵ saves</span>
        </div>
      )}
      <div className="rov-meta">
        <label className="rov-every">
          every
          <select
            value={minutes}
            onChange={(e) => void changeInterval(Number(e.target.value))}
            aria-label="How often"
          >
            {options.map((o) => (
              <option key={o.minutes} value={o.minutes}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span>
          {status === 'running'
            ? 'running now'
            : r.enabled
              ? `next ${inTime(r.nextRunAt, now)}`
              : 'paused'}
        </span>
        <span className={`rov-last rov-last-${status ?? 'none'}`}>
          {r.lastRunAt
            ? `last ${ago(r.lastRunAt, now)}: ${status === 'error' ? 'failed' : status === 'running' ? 'running' : 'ok'}`
            : 'not run yet'}
        </span>
        <span className="rov-cost" data-testid="routine-cost">
          {typical === null
            ? 'cost unknown until it has run'
            : `about ${compactTokens(typical)} per run${
                week !== null && r.enabled ? ` · ${compactTokens(week)} a week` : ''
              }`}
        </span>
        <button className="rov-link" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide runs' : `Runs (${runs.length})`}
        </button>
      </div>
      {saved && <div className="rov-saved">{saved}</div>}
      {status === 'error' && r.lastRunSummary && (
        <div className="rov-error">{r.lastRunSummary}</div>
      )}
      {open && (
        <div className="rov-runs">
          {runs.length === 0 && <div className="rov-hint">No runs yet.</div>}
          {runs.map((run, i) => (
            <button
              key={run.id}
              className={`rov-run rov-run-${run.status}`}
              onClick={i === 0 ? onOpenRun : undefined}
              title={i === 0 ? 'Open this run' : undefined}
              disabled={i !== 0}
            >
              <span className={`routine-tree-dot routine-dot-${run.status}`} />
              <span className="rov-run-when">{ago(run.startedAt, now)}</span>
              <span className="rov-run-tokens">
                {run.tokens > 0 ? `${compactTokens(run.tokens)} tokens` : ''}
              </span>
              <span className="rov-run-summary">{run.summary ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
