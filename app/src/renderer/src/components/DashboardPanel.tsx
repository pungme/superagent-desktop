import { useEffect, useState } from 'react'

interface Dash {
  turnsToday: number
  tasksToday: number
  streak: number
  longestStreak: number
  spark: { day: string; turns: number }[]
  attention: { name: string; turns: number }[]
  attentionAll: { name: string; turns: number }[]
  hours: number[]
  busiestDay: { date: string; turns: number } | null
  topSites: { host: string; title: string; visits: number }[]
  avgTurns30: number
  firstTs: number | null
  totals: {
    turns: number
    tasks: number
    chats: number
    projects: number
    messages: number
    sites: number
    visits: number
  }
}

/**
 * Where your attention went — all local. Turns are reconstructed from both the
 * activity log and chat transcripts (which reach back before logging existed),
 * browsing stats come from the omnibar history.
 */
export function DashboardPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [dash, setDash] = useState<Dash | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    window.cove
      .eventsDashboard()
      .then((d) => {
        // Never let a malformed payload (e.g. a stale main process during dev)
        // throw mid-render and take the whole app down — normalize it here.
        setDash({
          turnsToday: d?.turnsToday ?? 0,
          tasksToday: d?.tasksToday ?? 0,
          streak: d?.streak ?? 0,
          longestStreak: d?.longestStreak ?? 0,
          spark: Array.isArray(d?.spark)
            ? d.spark.map((s) =>
                typeof s === 'number' ? { day: '', turns: s } : { day: s?.day ?? '', turns: s?.turns ?? 0 }
              )
            : [],
          attention: d?.attention ?? [],
          attentionAll: d?.attentionAll ?? [],
          hours: Array.isArray(d?.hours) ? d.hours : new Array(24).fill(0),
          busiestDay: d?.busiestDay ?? null,
          topSites: d?.topSites ?? [],
          avgTurns30: d?.avgTurns30 ?? 0,
          firstTs: d?.firstTs ?? null,
          totals: {
            turns: d?.totals?.turns ?? 0,
            tasks: d?.totals?.tasks ?? 0,
            chats: d?.totals?.chats ?? 0,
            projects: d?.totals?.projects ?? 0,
            messages: d?.totals?.messages ?? 0,
            sites: d?.totals?.sites ?? 0,
            visits: d?.totals?.visits ?? 0
          }
        })
      })
      .catch(() => setFailed(true))
  }, [])

  const maxTurns = Math.max(1, ...(dash?.attention.map((a) => a.turns) ?? [1]))
  const maxAll = Math.max(1, ...(dash?.attentionAll.map((a) => a.turns) ?? [1]))
  const maxSpark = Math.max(1, ...(dash?.spark.map((s) => s.turns) ?? [1]))
  const maxHour = Math.max(1, ...(dash?.hours ?? [1]))
  const maxSite = Math.max(1, ...(dash?.topSites.map((s) => s.visits) ?? [1]))

  return (
    <div className="dash-view">
      <div className="dash-head">
        <h2>Dashboard</h2>
        <button className="dash-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="dash">
        {failed ? (
          <div className="dash-empty">Couldn&rsquo;t load activity data — try reopening.</div>
        ) : !dash ? (
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
              <div className="dash-stat">
                <span className="dash-stat-n">{dash.longestStreak}</span>
                <span className="dash-stat-l">longest streak</span>
              </div>
              <div className="dash-stat">
                <span className="dash-stat-n">{dash.avgTurns30}</span>
                <span className="dash-stat-l">avg turns / active day</span>
              </div>
              <div className="dash-stat">
                <span className="dash-stat-n">{dash.busiestDay?.turns ?? 0}</span>
                <span className="dash-stat-l">
                  best day{dash.busiestDay ? ` · ${dash.busiestDay.date}` : ''}
                </span>
              </div>
            </div>

            <div className="dash-section">
              <h3>Last 14 days</h3>
              <div className="dash-spark">
                {dash.spark.map((s, i) => (
                  <div key={i} className="dash-spark-col" title={`${s.turns} turns`}>
                    <div className="dash-spark-track">
                      <div
                        className="dash-spark-bar"
                        style={{ height: `${Math.max(3, (s.turns / maxSpark) * 100)}%` }}
                      />
                    </div>
                    <span className="dash-spark-day">{s.day}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="dash-section">
              <h3>Where your attention went (7 days)</h3>
              {dash.attention.length === 0 ? (
                <div className="dash-empty">Nothing this week yet.</div>
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

            <div className="dash-section">
              <h3>All-time projects</h3>
              {dash.attentionAll.length === 0 ? (
                <div className="dash-empty">No activity recorded yet.</div>
              ) : (
                dash.attentionAll.map((a) => (
                  <div key={a.name} className="dash-row">
                    <span className="dash-row-name">{a.name}</span>
                    <div className="dash-row-track">
                      <div
                        className="dash-row-bar dash-bar-alt"
                        style={{ width: `${(a.turns / maxAll) * 100}%` }}
                      />
                    </div>
                    <span className="dash-row-n">{a.turns}</span>
                  </div>
                ))
              )}
            </div>

            <div className="dash-section">
              <h3>Busiest hours (30 days)</h3>
              <div className="dash-hours">
                {dash.hours.map((n, h) => (
                  <div
                    key={h}
                    className="dash-hour-bar"
                    style={{ height: `${Math.max(3, (n / maxHour) * 100)}%` }}
                    title={`${String(h).padStart(2, '0')}:00 — ${n} turns`}
                  />
                ))}
              </div>
              <div className="dash-hours-axis">
                <span>0</span>
                <span>6</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
            </div>

            <div className="dash-section">
              <h3>Top sites</h3>
              {dash.topSites.length === 0 ? (
                <div className="dash-empty">No pages visited yet.</div>
              ) : (
                dash.topSites.map((s) => (
                  <div key={s.host} className="dash-row" title={s.title}>
                    <span className="dash-row-name">{s.host}</span>
                    <div className="dash-row-track">
                      <div
                        className="dash-row-bar dash-bar-site"
                        style={{ width: `${(s.visits / maxSite) * 100}%` }}
                      />
                    </div>
                    <span className="dash-row-n">{s.visits}</span>
                  </div>
                ))
              )}
            </div>

            <div className="dash-section">
              <h3>All time</h3>
              <div className="dash-totals">
                <div>
                  <b>{dash.totals.turns.toLocaleString()}</b> turns
                </div>
                <div>
                  <b>{dash.totals.messages.toLocaleString()}</b> messages
                </div>
                <div>
                  <b>{dash.totals.tasks.toLocaleString()}</b> tasks done
                </div>
                <div>
                  <b>{dash.totals.chats.toLocaleString()}</b> chats
                </div>
                <div>
                  <b>{dash.totals.projects.toLocaleString()}</b> projects
                </div>
                <div>
                  <b>{dash.totals.visits.toLocaleString()}</b> page visits
                </div>
                <div>
                  <b>{dash.totals.sites.toLocaleString()}</b> sites
                </div>
              </div>
              {dash.firstTs && (
                <div className="dash-since">
                  since{' '}
                  {new Date(dash.firstTs).toLocaleDateString(undefined, {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
