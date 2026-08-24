import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEvent } from '../../../preload'
import { parseICS } from '../lib/ics'

// --- date helpers (local time, no external deps) --------------------------
const pad = (n: number): string => String(n).padStart(2, '0')
/** YYYY-MM-DD for a Date, in local time. */
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** The date portion of an event's start/end (works for all-day and timed). */
const dayOf = (iso: string): string => iso.slice(0, 10)
const addDays = (d: Date, n: number): Date => {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}
const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1)
const startOfWeek = (d: Date): Date => addDays(d, -d.getDay()) // back to Sunday
const sameYmd = (a: Date, b: Date): boolean => ymd(a) === ymd(b)

/** Minutes past midnight for a timed ISO (`YYYY-MM-DDTHH:mm`); 0 if none. */
const minutesOf = (iso: string): number => {
  if (iso.length < 16) return 0
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
// A small, calm palette for events (macOS-ish).
const COLORS = ['#3b82f6', '#22c55e', '#ef4444', '#f59e0b', '#a855f7', '#14b8a6', '#ec4899']

const HOUR_H = 44 // px per hour in the time grid
const DAY_MIN = 24 * 60

/** The 42 days (6 weeks) that fill a month grid, starting on Sunday. */
function monthGrid(month: Date): Date[] {
  const first = startOfMonth(month)
  const start = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

type View = 'day' | 'week' | 'month'

interface Draft {
  id?: string
  title: string
  allDay: boolean
  date: string // YYYY-MM-DD
  startTime: string // HH:mm
  endTime: string // HH:mm
  notes: string
  color: string
}

function emptyDraft(date: string, startTime = '09:00'): Draft {
  const [h, m] = startTime.split(':').map(Number)
  const endTime = `${pad(Math.min(h + 1, 23))}:${pad(m)}`
  return { title: '', allDay: false, date, startTime, endTime, notes: '', color: COLORS[0] }
}

function draftFromEvent(e: CalendarEvent): Draft {
  const startTime = e.allDay ? '09:00' : e.start.slice(11, 16) || '09:00'
  const endTime = e.allDay ? '10:00' : (e.end?.slice(11, 16) ?? startTime)
  return {
    id: e.id,
    title: e.title,
    allDay: e.allDay,
    date: dayOf(e.start),
    startTime,
    endTime,
    notes: e.notes,
    color: e.color ?? COLORS[0]
  }
}

function draftToPayload(d: Draft): {
  title: string
  start: string
  end: string | null
  allDay: boolean
  notes: string
  color: string
} {
  if (d.allDay) {
    return { title: d.title, start: d.date, end: d.date, allDay: true, notes: d.notes, color: d.color }
  }
  return {
    title: d.title,
    start: `${d.date}T${d.startTime}`,
    end: `${d.date}T${d.endTime}`,
    allDay: false,
    notes: d.notes,
    color: d.color
  }
}

// Lay out a day's timed events into columns so overlaps sit side by side, the way
// Google Calendar does. Returns each event with its column and the cluster width.
interface Placed {
  e: CalendarEvent
  start: number
  end: number
  col: number
  cols: number
}
function packDay(events: CalendarEvent[]): Placed[] {
  const items = events
    .map((e) => {
      const start = minutesOf(e.start)
      const rawEnd = e.end ? minutesOf(e.end) : start + 30
      // Keep it on the day and at least a sliver tall.
      const end = Math.min(Math.max(rawEnd, start + 20), DAY_MIN)
      return { e, start, end, col: 0, cols: 1 }
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const out: Placed[] = []
  let cluster: Placed[] = []
  let clusterEnd = -1
  const flush = (): void => {
    const colEnds: number[] = []
    for (const it of cluster) {
      let c = colEnds.findIndex((end) => end <= it.start)
      if (c === -1) {
        c = colEnds.length
        colEnds.push(it.end)
      } else colEnds[c] = it.end
      it.col = c
    }
    for (const it of cluster) {
      it.cols = colEnds.length
      out.push(it)
    }
    cluster = []
    clusterEnd = -1
  }
  for (const it of items) {
    if (cluster.length && it.start >= clusterEnd) flush()
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.end)
  }
  flush()
  return out
}

const fmtHourLabel = (h: number): string => {
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

export function CalendarApp(): React.JSX.Element {
  // `new Date()` is fine in the renderer (only workflow scripts forbid it).
  const [now, setNow] = useState(() => new Date())
  const today = ymd(now)
  const [view, setView] = useState<View>('week')
  const [cursor, setCursor] = useState(() => new Date())
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Tick the now-line every minute.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // The date span currently on screen — drives both the query and the grid.
  const span = useMemo(() => {
    if (view === 'month') {
      const g = monthGrid(startOfMonth(cursor))
      return { days: g, from: g[0], to: addDays(g[g.length - 1], 1) }
    }
    if (view === 'week') {
      const s = startOfWeek(cursor)
      const days = Array.from({ length: 7 }, (_, i) => addDays(s, i))
      return { days, from: days[0], to: addDays(days[6], 1) }
    }
    return { days: [new Date(cursor)], from: new Date(cursor), to: addDays(cursor, 1) }
  }, [view, cursor])

  const refresh = useCallback(async (): Promise<void> => {
    setEvents(await window.cove.calendarList(ymd(span.from), ymd(span.to)))
  }, [span.from, span.to])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Scroll the time grid to ~7am when entering a timed view.
  useEffect(() => {
    if (view !== 'month' && gridRef.current) gridRef.current.scrollTop = 7 * HOUR_H
  }, [view])

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of events) {
      const key = dayOf(e.start)
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }
    for (const list of map.values())
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
    return map
  }, [events])

  useEffect(() => {
    if (!draft) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDraft(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft])

  const save = async (): Promise<void> => {
    if (!draft) return
    const payload = draftToPayload({ ...draft, title: draft.title.trim() || 'Untitled event' })
    if (draft.id) await window.cove.calendarUpdate(draft.id, payload)
    else await window.cove.calendarAdd(payload)
    setDraft(null)
    await refresh()
  }
  const remove = async (): Promise<void> => {
    if (draft?.id) await window.cove.calendarRemove(draft.id)
    setDraft(null)
    await refresh()
  }

  // Import events from a .ics file (Google Calendar, Apple Calendar, Outlook…).
  const importIcs = async (file: File): Promise<void> => {
    try {
      const parsed = parseICS(await file.text())
      if (!parsed.length) {
        setImportMsg('No events found in that file.')
        return
      }
      for (const e of parsed) {
        await window.cove.calendarAdd({
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          notes: e.notes,
          color: COLORS[0]
        })
      }
      await refresh()
      setImportMsg(`Imported ${parsed.length} event${parsed.length === 1 ? '' : 's'}.`)
    } catch {
      setImportMsg("Couldn't read that file.")
    }
  }

  // Clear the import toast after a few seconds.
  useEffect(() => {
    if (!importMsg) return
    const t = setTimeout(() => setImportMsg(null), 3500)
    return () => clearTimeout(t)
  }, [importMsg])

  const step = (dir: number): void => {
    if (view === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1))
    else setCursor(addDays(cursor, dir * (view === 'week' ? 7 : 1)))
  }

  const title = (): string => {
    if (view === 'month') return `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`
    if (view === 'day')
      return cursor.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })
    const s = span.days[0]
    const e = span.days[6]
    const sameMonth = s.getMonth() === e.getMonth()
    return sameMonth
      ? `${MONTHS[s.getMonth()]} ${s.getDate()} – ${e.getDate()}, ${s.getFullYear()}`
      : `${MONTHS[s.getMonth()]} ${s.getDate()} – ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`
  }

  const openTimedDraft = (day: Date, hour: number): void =>
    setDraft(emptyDraft(ymd(day), `${pad(hour)}:00`))

  const nowMin = now.getHours() * 60 + now.getMinutes()

  return (
    <div className="cal">
      <div className="cal-head">
        <div className="cal-nav">
          <button onClick={() => step(-1)} aria-label="Previous">
            ‹
          </button>
          <button className="cal-today" onClick={() => setCursor(new Date())}>
            Today
          </button>
          <button onClick={() => step(1)} aria-label="Next">
            ›
          </button>
          <span className="cal-title">{title()}</span>
        </div>
        <div className="cal-head-actions">
          <div className="cal-viewseg">
            {(['day', 'week', 'month'] as View[]).map((v) => (
              <button
                key={v}
                className={view === v ? 'on' : ''}
                onClick={() => setView(v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <button
            className="cal-import"
            onClick={() => fileRef.current?.click()}
            title="Import events from a .ics file"
          >
            Import
          </button>
          <button className="cal-new" onClick={() => setDraft(emptyDraft(ymd(cursor)))}>
            + Event
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".ics,text/calendar"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importIcs(f)
              e.target.value = '' // allow re-importing the same file
            }}
          />
        </div>
      </div>
      {importMsg && <div className="cal-toast">{importMsg}</div>}

      {view === 'month' ? (
        <div className="cal-monthwrap">
          <div className="cal-weekdays">
            {WEEKDAYS.map((w) => (
              <div key={w} className="cal-weekday">
                {w}
              </div>
            ))}
          </div>
          <div className="cal-grid">
            {span.days.map((d) => {
              const key = ymd(d)
              const dayEvents = byDay.get(key) ?? []
              const inMonth = d.getMonth() === cursor.getMonth()
              return (
                <div
                  key={key}
                  className={`cal-cell ${inMonth ? '' : 'other'}`}
                  onDoubleClick={() => setDraft(emptyDraft(key))}
                >
                  <button
                    className={`cal-daynum ${key === today ? 'today' : ''}`}
                    onClick={() => {
                      setCursor(new Date(d))
                      setView('day')
                    }}
                  >
                    {d.getDate()}
                  </button>
                  <div className="cal-cell-events">
                    {dayEvents.slice(0, 3).map((e) => (
                      <button
                        key={e.id}
                        className={`cal-chip ${e.allDay ? '' : 'timed'}`}
                        style={
                          e.allDay
                            ? { background: e.color ?? COLORS[0] }
                            : { color: e.color ?? COLORS[0] }
                        }
                        title={e.title}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setDraft(draftFromEvent(e))
                        }}
                      >
                        {!e.allDay && (
                          <span
                            className="cal-chip-dot"
                            style={{ background: e.color ?? COLORS[0] }}
                          />
                        )}
                        {!e.allDay && <span className="cal-chip-time">{e.start.slice(11, 16)}</span>}
                        <span className="cal-chip-title">{e.title}</span>
                      </button>
                    ))}
                    {dayEvents.length > 3 && (
                      <button
                        className="cal-more"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setCursor(new Date(d))
                          setView('day')
                        }}
                      >
                        +{dayEvents.length - 3} more
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className={`cal-timegrid ${view}`}>
          <div className="cal-tg-head">
            <div className="cal-tg-gutter" />
            {span.days.map((d) => {
              const isToday = sameYmd(d, now)
              return (
                <button
                  key={ymd(d)}
                  className={`cal-tg-dayhead ${isToday ? 'today' : ''}`}
                  onClick={() => {
                    setCursor(new Date(d))
                    setView('day')
                  }}
                >
                  <span className="cal-tg-wd">{WEEKDAYS[d.getDay()]}</span>
                  <span className="cal-tg-dnum">{d.getDate()}</span>
                </button>
              )
            })}
          </div>

          <div className="cal-tg-allday">
            <div className="cal-tg-gutter cal-tg-alllabel">all-day</div>
            {span.days.map((d) => {
              const key = ymd(d)
              const all = (byDay.get(key) ?? []).filter((e) => e.allDay)
              return (
                <div
                  key={key}
                  className="cal-tg-alldaycell"
                  onDoubleClick={() => setDraft({ ...emptyDraft(key), allDay: true })}
                >
                  {all.map((e) => (
                    <button
                      key={e.id}
                      className="cal-allday-chip"
                      style={{ background: e.color ?? COLORS[0] }}
                      onClick={() => setDraft(draftFromEvent(e))}
                    >
                      {e.title}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>

          <div className="cal-tg-scroll" ref={gridRef}>
            <div className="cal-tg-body" style={{ height: `${24 * HOUR_H}px` }}>
              <div className="cal-tg-hours">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="cal-tg-hour" style={{ height: `${HOUR_H}px` }}>
                    {h > 0 && <span className="cal-tg-hourlabel">{fmtHourLabel(h)}</span>}
                  </div>
                ))}
              </div>
              <div className="cal-tg-cols">
                {span.days.map((d) => {
                  const key = ymd(d)
                  const timed = (byDay.get(key) ?? []).filter((e) => !e.allDay)
                  const placed = packDay(timed)
                  const isToday = sameYmd(d, now)
                  return (
                    <div key={key} className="cal-tg-col">
                      {Array.from({ length: 24 }, (_, h) => (
                        <div
                          key={h}
                          className="cal-tg-slot"
                          style={{ height: `${HOUR_H}px` }}
                          onClick={() => openTimedDraft(d, h)}
                        />
                      ))}
                      {isToday && (
                        <div
                          className="cal-tg-now"
                          style={{ top: `${(nowMin / 60) * HOUR_H}px` }}
                        />
                      )}
                      {placed.map(({ e, start, end, col, cols }) => (
                        <button
                          key={e.id}
                          className="cal-tg-event"
                          style={{
                            top: `${(start / 60) * HOUR_H}px`,
                            height: `${((end - start) / 60) * HOUR_H - 2}px`,
                            left: `calc(${(col / cols) * 100}% + 2px)`,
                            width: `calc(${(1 / cols) * 100}% - 4px)`,
                            background: e.color ?? COLORS[0]
                          }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setDraft(draftFromEvent(e))
                          }}
                        >
                          <span className="cal-tg-event-time">{e.start.slice(11, 16)}</span>
                          <span className="cal-tg-event-title">{e.title}</span>
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <div className="cal-modal-backdrop" onClick={() => setDraft(null)}>
          <div className="cal-modal" onClick={(e) => e.stopPropagation()}>
            <input
              className="cal-modal-title"
              placeholder="Event title"
              value={draft.title}
              autoFocus
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
            <label className="cal-modal-allday">
              <input
                type="checkbox"
                checked={draft.allDay}
                onChange={(e) => setDraft({ ...draft, allDay: e.target.checked })}
              />
              All day
            </label>
            <div className="cal-modal-row">
              <input
                type="date"
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
              />
              {!draft.allDay && (
                <>
                  <input
                    type="time"
                    value={draft.startTime}
                    onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
                  />
                  <span className="cal-modal-dash">–</span>
                  <input
                    type="time"
                    value={draft.endTime}
                    onChange={(e) => setDraft({ ...draft, endTime: e.target.value })}
                  />
                </>
              )}
            </div>
            <div className="cal-modal-colors">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`cal-swatch ${draft.color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setDraft({ ...draft, color: c })}
                />
              ))}
            </div>
            <textarea
              className="cal-modal-notes"
              placeholder="Notes"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
            <div className="cal-modal-actions">
              {draft.id && (
                <button className="cal-modal-delete" onClick={remove}>
                  Delete
                </button>
              )}
              <div className="cal-modal-spacer" />
              <button className="cal-modal-cancel" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className="cal-modal-save" onClick={save}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
