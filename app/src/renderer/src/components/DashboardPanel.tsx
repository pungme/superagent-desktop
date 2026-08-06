import { useEffect, useState } from 'react'
import { SlideOverPanel } from './SlideOverPanel'

interface Dash {
  turnsToday: number
  tasksToday: number
  streak: number
  attention: { name: string; turns: number }[]
  spark: number[]
}

/**
 * Where your attention went — all local, computed from the activity log the
 * hook server writes (turns) and the chat mirrors (completed tasks).
 */
export function DashboardPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [dash, setDash] = useState<Dash | null>(null)

  useEffect(() => {
    window.cove.eventsDashboard().then(setDash)
  }, [])

  const maxTurns = Math.max(1, ...(dash?.attention.map((a) => a.turns) ?? [1]))
  const maxSpark = Math.max(1, ...(dash?.spark ?? [1]))

  return (
    <SlideOverPanel title="Dashboard" onClose={onClose}>
      <div className="dash">
        {!dash ? (
          <div className="dash-empty">Loading…</div>
        ) : (
          <>
            <div className="dash-stats">
              <div className="dash-stat">
                <span className="dash-stat-n">{dash.turnsToday}</span>
                <span className="dash-stat-l">turns today</span>
              </div>
              <div className="dash-stat">
                <span className="dash-stat-n">{dash.tasksToday}</span>
                <span className="dash-stat-l">tasks done today</span>
              </div>
              <div className="dash-stat">
                <span className="dash-stat-n">
                  {dash.streak}
                  <span className="dash-flame">{dash.streak > 0 ? ' 🔥' : ''}</span>
                </span>
                <span className="dash-stat-l">day streak</span>
              </div>
            </div>

            <div className="dash-section">
              <h3>Last 14 days</h3>
              <div className="dash-spark" title="Turns per day">
                {dash.spark.map((n, i) => (
                  <div
                    key={i}
                    className="dash-spark-bar"
                    style={{ height: `${Math.max(4, (n / maxSpark) * 100)}%` }}
                    title={`${n} turns`}
                  />
                ))}
              </div>
            </div>

            <div className="dash-section">
              <h3>Where your attention went (7 days)</h3>
              {dash.attention.length === 0 ? (
                <div className="dash-empty">No activity recorded yet — it starts counting now.</div>
              ) : (
                dash.attention.map((a) => (
                  <div key={a.name} className="dash-row">
                    <span className="dash-row-name">{a.name}</span>
                    <div className="dash-row-track">
                      <div
                        className="dash-row-bar"
                        style={{ width: `${(a.turns / maxTurns) * 100}%` }}
                      />
                    </div>
                    <span className="dash-row-n">{a.turns}</span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </SlideOverPanel>
  )
}
