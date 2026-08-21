import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CalendarEvent } from '../../../preload'

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

/** The 42 days (6 weeks) that fill a month grid, starting on Sunday. */
function monthGrid(month: Date): Date[] {
  const first = startOfMonth(month)
  const start = addDays(first, -first.getDay()) // back to the Sunday on/before the 1st
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

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

function emptyDraft(date: string): Draft {
  return {
    title: '',
    allDay: false,
    date,
    startTime: '09:00',
    endTime: '10:00',
    notes: '',
    color: COLORS[0]
  }
}

function draftFromEvent(e: CalendarEvent): Draft {
  const startTime = e.allDay ? '09:00' : (e.start.slice(11, 16) || '09:00')
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

export function CalendarApp(): React.JSX.Element {
  // `new Date()` is fine in the renderer (only workflow scripts forbid it).
  const today = ymd(new Date())
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState(today)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)

  const grid = useMemo(() => monthGrid(month), [month])

  const refresh = useCallback(async (): Promise<void> => {
    // Pull a padded range so events on the leading/trailing days show too.
    const from = ymd(grid[0])
    const to = ymd(addDays(grid[grid.length - 1], 1))
    setEvents(await window.cove.calendarList(from, to))
  }, [grid])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Events grouped by day (YYYY-MM-DD), sorted all-day first then by time.
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of events) {
      const key = dayOf(e.start)
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
    }
    return map
  }, [events])

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

  const monthLabel = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`
  const selectedEvents = byDay.get(selected) ?? []

  const fmtTime = (e: CalendarEvent): string =>
    e.allDay ? 'All day' : e.start.slice(11, 16)

  return (
    <div className="cal">
      <div className="cal-main">
        <div className="cal-head">
          <div className="cal-nav">
            <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
              ‹
            </button>
            <span className="cal-month">{monthLabel}</span>
            <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
              ›
            </button>
          </div>
          <div className="cal-head-actions">
            <button
              className="cal-today"
              onClick={() => {
                setMonth(startOfMonth(new Date()))
                setSelected(today)
              }}
            >
              Today
            </button>
            <button className="cal-new" onClick={() => setDraft(emptyDraft(selected))}>
              + Event
            </button>
          </div>
        </div>

        <div className="cal-weekdays">
          {WEEKDAYS.map((w) => (
            <div key={w} className="cal-weekday">
              {w}
            </div>
          ))}
        </div>

        <div className="cal-grid">
          {grid.map((d) => {
            const key = ymd(d)
            const dayEvents = byDay.get(key) ?? []
            const inMonth = d.getMonth() === month.getMonth()
            return (
              <div
                key={key}
                className={`cal-cell ${inMonth ? '' : 'other'} ${key === selected ? 'selected' : ''}`}
                onClick={() => setSelected(key)}
                onDoubleClick={() => setDraft(emptyDraft(key))}
              >
                <span className={`cal-daynum ${key === today ? 'today' : ''}`}>{d.getDate()}</span>
                <div className="cal-cell-events">
                  {dayEvents.slice(0, 3).map((e) => (
                    <button
                      key={e.id}
                      className="cal-chip"
                      style={{ background: e.color ?? COLORS[0] }}
                      title={e.title}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setDraft(draftFromEvent(e))
                      }}
                    >
                      {!e.allDay && <span className="cal-chip-time">{e.start.slice(11, 16)}</span>}
                      <span className="cal-chip-title">{e.title}</span>
                    </button>
                  ))}
                  {dayEvents.length > 3 && (
                    <span className="cal-more">+{dayEvents.length - 3} more</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* The selected day's agenda, so you always have a readable list. */}
      <div className="cal-side">
        <div className="cal-side-head">
          <strong>
            {new Date(`${selected}T00:00`).toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric'
            })}
          </strong>
          <button className="cal-side-add" onClick={() => setDraft(emptyDraft(selected))}>
            +
          </button>
        </div>
        {selectedEvents.length === 0 ? (
          <div className="cal-side-empty">No events.</div>
        ) : (
          <div className="cal-agenda">
            {selectedEvents.map((e) => (
              <button key={e.id} className="cal-agenda-row" onClick={() => setDraft(draftFromEvent(e))}>
                <span className="cal-agenda-dot" style={{ background: e.color ?? COLORS[0] }} />
                <span className="cal-agenda-time">{fmtTime(e)}</span>
                <span className="cal-agenda-title">{e.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

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
