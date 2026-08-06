import { useEffect, useState } from 'react'

interface Dash {
  turnsToday: number
  tasksToday: number
  streak: number
  longestStreak: number
  spark: { day: string; turns: number; tokens: number }[]
  attention: { name: string; turns: number }[]
  attentionAll: { name: string; turns: number }[]
  hours: number[]
  busiestDay: { date: string; turns: number } | null
  avgTurns30: number
  firstTs: number | null
  totals: {
    turns: number
    tasks: number
    chats: number
    projects: number
    messages: number
    tokens: number
  }
}

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1000)}k` : `${n}`

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
                typeof s === 'number'
                  ? { day: '', turns: s, tokens: 0 }
                  : { day: s?.day ?? '', turns: s?.turns ?? 0, tokens: s?.tokens ?? 0 }
              )
            : [],
          attention: d?.attention ?? [],
          attentionAll: d?.attentionAll ?? [],
          hours: Array.isArray(d?.hours) ? d.hours : new Array(24).fill(0),
          busiestDay: d?.busiestDay ?? null,
          avgTurns30: d?.avgTurns30 ?? 0,
          firstTs: d?.firstTs ?? null,
          totals: {
            turns: d?.totals?.turns ?? 0,
            tasks: d?.totals?.tasks ?? 0,
            chats: d?.totals?.chats ?? 0,
            projects: d?.totals?.projects ?? 0,
            messages: d?.totals?.messages ?? 0,
            tokens: d?.totals?.tokens ?? 0
          }
        })
      })
      .catch(() => setFailed(true))
  }, [])

  const maxTurns = Math.max(1, ...(dash?.attention.map((a) => a.turns) ?? [1]))
  const maxAll = Math.max(1, ...(dash?.attentionAll.map((a) => a.turns) ?? [1]))
  // Tokens are the interesting series; fall back to turns until any exist
  // (token recording only starts with this build).
  const hasTokens = (dash?.spark ?? []).some((s) => s.tokens > 0)
  const sparkVal = (s: { turns: number; tokens: number }): number =>
    hasTokens ? s.tokens : s.turns
  const maxSpark = Math.max(1, ...(dash?.spark.map(sparkVal) ?? [1]))
  const maxHour = Math.max(1, ...(dash?.hours ?? [1]))

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
              <h3>{hasTokens ? 'Tokens (14 days)' : 'Turns (14 days)'}</h3>
              <div className="dash-spark">
                {dash.spark.map((s, i) => (
                  <div
                    key={i}
                    className="dash-spark-col"
                    title={`${fmtTokens(s.tokens)} tokens · ${s.turns} turns`}
                  >
                    <span className="dash-spark-val">
                      {sparkVal(s) > 0 ? (hasTokens ? fmtTokens(s.tokens) : s.turns) : ''}
                    </span>
                    <div className="dash-spark-track">
                      <div
                        className="dash-spark-bar"
                        style={{ height: `${Math.max(3, (sparkVal(s) / maxSpark) * 100)}%` }}
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
                  <b>{fmtTokens(dash.totals.tokens)}</b> tokens
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
