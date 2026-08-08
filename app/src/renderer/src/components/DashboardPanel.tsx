import { useEffect, useState } from 'react'
import { useEscapeClose } from '../hooks/useEscapeClose'

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
  activeDays30: number
  firstTs: number | null
  tokens: { today: number; week: number; month: number }
  trends: { turnsWeek: number; turnsPrevWeek: number; tokensWeek: number; tokensPrevWeek: number }
  weekdayAvg: number[]
  tokensByProject: { name: string; tokens: number }[]
  avgMsgsPerChat: number
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

/** ▲ 23% / ▼ 8% / — vs the previous period; hidden when there's no baseline. */
function Trend({ cur, prev }: { cur: number; prev: number }): React.JSX.Element | null {
  if (prev === 0 && cur === 0) return null
  if (prev === 0) return <span className="dash-trend up">new</span>
  const pct = Math.round(((cur - prev) / prev) * 100)
  if (pct === 0) return <span className="dash-trend flat">—</span>
  return (
    <span className={`dash-trend ${pct > 0 ? 'up' : 'down'}`}>
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  )
}

/**
 * Where your attention went — all local. Turns are reconstructed from both the
 * activity log and chat transcripts (which reach back before logging existed),
 * browsing stats come from the omnibar history.
 */
export function DashboardPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [dash, setDash] = useState<Dash | null>(null)
  useEscapeClose(onClose)
  const [failed, setFailed] = useState(false)
  const [range, setRange] = useState(14)
  /** Bumped by "Try again" — the only thing that re-runs a fetch on demand. */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    window.cove
      .eventsDashboard(range)
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
          activeDays30: d?.activeDays30 ?? 0,
          firstTs: d?.firstTs ?? null,
          tokens: {
            today: d?.tokens?.today ?? 0,
            week: d?.tokens?.week ?? 0,
            month: d?.tokens?.month ?? 0
          },
          trends: {
            turnsWeek: d?.trends?.turnsWeek ?? 0,
            turnsPrevWeek: d?.trends?.turnsPrevWeek ?? 0,
            tokensWeek: d?.trends?.tokensWeek ?? 0,
            tokensPrevWeek: d?.trends?.tokensPrevWeek ?? 0
          },
          weekdayAvg:
            Array.isArray(d?.weekdayAvg) && d.weekdayAvg.length === 7
              ? d.weekdayAvg
              : new Array(7).fill(0),
          tokensByProject: d?.tokensByProject ?? [],
          avgMsgsPerChat: d?.avgMsgsPerChat ?? 0,
          totals: {
            turns: d?.totals?.turns ?? 0,
            tasks: d?.totals?.tasks ?? 0,
            chats: d?.totals?.chats ?? 0,
            projects: d?.totals?.projects ?? 0,
            messages: d?.totals?.messages ?? 0,
            tokens: d?.totals?.tokens ?? 0
          }
        })
        // Belt and braces. Nothing can currently reach this with failed still
        // set — the range buttons are not rendered while the error is showing,
        // so "Try again", which clears the flag itself, is the only way back.
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [range, attempt])

  const maxTurns = Math.max(1, ...(dash?.attention.map((a) => a.turns) ?? [1]))
  const maxAll = Math.max(1, ...(dash?.attentionAll.map((a) => a.turns) ?? [1]))
  const hasTokens = (dash?.spark ?? []).some((s) => s.tokens > 0)
  const maxSpark = Math.max(1, ...(dash?.spark.map((s) => s.tokens) ?? [1]))
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
          <div className="dash-empty">
            <p>Couldn&rsquo;t load activity data.</p>
            <button
              className="dash-retry"
              onClick={() => {
                setFailed(false)
                setAttempt((n) => n + 1)
              }}
            >
              Try again
            </button>
          </div>
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
                <span className="dash-stat-n">
                  {dash.trends.turnsWeek}
                  <Trend cur={dash.trends.turnsWeek} prev={dash.trends.turnsPrevWeek} />
                </span>
                <span className="dash-stat-l">turns this week</span>
              </div>
              <div className="dash-stat">
                <span className="dash-stat-n">
                  {dash.streak}
                  <span className="dash-flame">{dash.streak > 0 ? ' 🔥' : ''}</span>
                </span>
                <span className="dash-stat-l">day streak · best {dash.longestStreak}</span>
              </div>
              <div className="dash-stat">
                <span className="dash-stat-n">{dash.avgTurns30}</span>
                <span className="dash-stat-l">avg turns / active day</span>
              </div>
              <div className="dash-stat">
                <span className="dash-stat-n">
                  {dash.activeDays30}
                  <span className="dash-stat-sub">/30</span>
                </span>
                <span className="dash-stat-l">active days</span>
              </div>
              <div className="dash-stat">
                <span className="dash-stat-n">{dash.busiestDay?.turns ?? 0}</span>
                <span className="dash-stat-l">
                  best day{dash.busiestDay ? ` · ${dash.busiestDay.date}` : ''}
                </span>
              </div>
            </div>

            <div className="dash-section">
              <div className="dash-section-head">
                <h3>
                  Tokens
                  {!hasTokens && <span className="dash-note"> — counting from today</span>}
                </h3>
                <div className="dash-range">
                  {[7, 14, 30, 90].map((r) => (
                    <button
                      key={r}
                      className={`dash-range-btn ${range === r ? 'active' : ''}`}
                      onClick={() => setRange(r)}
                    >
                      {r}d
                    </button>
                  ))}
                </div>
              </div>
              <div className="dash-tok-row">
                <div>
                  <b>{fmtTokens(dash.tokens.today)}</b> today
                </div>
                <div>
                  <b>{fmtTokens(dash.tokens.week)}</b> 7 days
                  <Trend cur={dash.trends.tokensWeek} prev={dash.trends.tokensPrevWeek} />
                </div>
                <div>
                  <b>{fmtTokens(dash.tokens.month)}</b> 30 days
                </div>
                <div>
                  <b>{fmtTokens(dash.totals.tokens)}</b> all time
                </div>
              </div>
              <div className={`dash-spark ${range > 14 ? 'many' : ''}`}>
                {dash.spark.map((s, i) => (
                  <div
                    key={i}
                    className="dash-spark-col dash-tip"
                    data-tip={`${fmtTokens(s.tokens)} tokens · ${s.turns} turns`}
                  >
                    <span className="dash-spark-val">
                      {s.tokens > 0 && range <= 14 ? fmtTokens(s.tokens) : ''}
                    </span>
                    <div className="dash-spark-track">
                      <div
                        className="dash-spark-bar"
                        style={{ height: `${Math.max(3, (s.tokens / maxSpark) * 100)}%` }}
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

            <div className="dash-cols">
              <div className="dash-section">
                <h3>Busiest hours (30 days)</h3>
                <div className="dash-hours">
                  {dash.hours.map((n, h) => (
                    <div
                      key={h}
                      className="dash-hour-wrap dash-tip"
                      data-tip={`${String(h).padStart(2, '0')}:00 · ${n} turns`}
                    >
                      <div
                        className="dash-hour-bar"
                        style={{ height: `${Math.max(6, (n / maxHour) * 100)}%` }}
                      />
                    </div>
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
                <h3>Weekly rhythm (avg turns, 8 weeks)</h3>
                <div className="dash-hours dash-weekdays">
                  {dash.weekdayAvg.map((n, i) => (
                    <div
                      key={i}
                      className="dash-hour-wrap dash-tip"
                      data-tip={`${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]} · avg ${n} turns`}
                    >
                      <div
                        className="dash-hour-bar"
                        style={{
                          height: `${Math.max(6, (n / Math.max(0.1, ...dash.weekdayAvg)) * 100)}%`
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="dash-hours-axis">
                  {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                    <span key={i}>{d}</span>
                  ))}
                </div>
              </div>
            </div>

            {dash.tokensByProject.length > 0 && (
              <div className="dash-section">
                <h3>Tokens by project (30 days)</h3>
                {dash.tokensByProject.map((p) => (
                  <div key={p.name} className="dash-row">
                    <span className="dash-row-name">{p.name}</span>
                    <div className="dash-row-track">
                      <div
                        className="dash-row-bar dash-bar-site"
                        style={{
                          width: `${(p.tokens / Math.max(1, dash.tokensByProject[0].tokens)) * 100}%`
                        }}
                      />
                    </div>
                    <span className="dash-row-n">{fmtTokens(p.tokens)}</span>
                  </div>
                ))}
              </div>
            )}

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
                <div>
                  <b>{dash.avgMsgsPerChat}</b> msgs / chat
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
