// Minimal iCalendar (.ics / RFC 5545) reader — enough to import events from
// Google Calendar, Apple Calendar, Outlook, etc. Pure and testable: it turns
// text into plain event objects in the shape the Calendar app already stores.

export interface ParsedEvent {
  title: string
  /** 'YYYY-MM-DD' for all-day, 'YYYY-MM-DDTHH:mm' for timed. */
  start: string
  end: string | null
  allDay: boolean
  notes: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Undo RFC 5545 line folding: a line starting with space/tab continues the last. */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: string[] = []
  for (const line of raw) {
    if (out.length && (line.startsWith(' ') || line.startsWith('\t'))) {
      out[out.length - 1] += line.slice(1)
    } else out.push(line)
  }
  return out
}

/** Unescape TEXT values (\n \, \; \\). */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

interface Prop {
  value: string
  params: string
}

/** A DATE / DATE-TIME value → our string shape, honoring VALUE=DATE and a UTC 'Z'. */
function parseDate(p: Prop): { value: string; allDay: boolean } | null {
  const dateOnly = /^\d{8}$/.test(p.value)
  if (/VALUE=DATE(?![-\w])/i.test(p.params) || dateOnly) {
    const m = p.value.match(/^(\d{4})(\d{2})(\d{2})/)
    return m ? { value: `${m[1]}-${m[2]}-${m[3]}`, allDay: true } : null
  }
  const m = p.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, , z] = m
  if (z) {
    // UTC → the viewer's local wall clock.
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi))
    return {
      value: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
      allDay: false
    }
  }
  // Floating or TZID-tagged local time — taken at face value (wall clock).
  return { value: `${y}-${mo}-${d}T${h}:${mi}`, allDay: false }
}

function buildEvent(props: Map<string, Prop>): ParsedEvent | null {
  const dtstart = props.get('DTSTART')
  if (!dtstart) return null
  const start = parseDate(dtstart)
  if (!start) return null

  const dtend = props.get('DTEND')
  const end = dtend ? parseDate(dtend) : null

  const title = props.has('SUMMARY') ? unescapeText(props.get('SUMMARY')!.value).trim() : ''
  const notes = props.has('DESCRIPTION') ? unescapeText(props.get('DESCRIPTION')!.value).trim() : ''

  return {
    title: title || 'Untitled event',
    start: start.value,
    // For all-day events ICS DTEND is exclusive (the next day); our model keeps a
    // single day, so collapse to the start date rather than importing a day late.
    end: start.allDay ? start.value : (end?.value ?? null),
    allDay: start.allDay,
    notes
  }
}

/** Parse an .ics document into events. Unknown/malformed VEVENTs are skipped. */
export function parseICS(text: string): ParsedEvent[] {
  const lines = unfold(text)
  const events: ParsedEvent[] = []
  let cur: Map<string, Prop> | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === 'BEGIN:VEVENT') {
      cur = new Map()
      continue
    }
    if (trimmed === 'END:VEVENT') {
      if (cur) {
        const ev = buildEvent(cur)
        if (ev) events.push(ev)
      }
      cur = null
      continue
    }
    if (!cur) continue

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const left = line.slice(0, colon)
    const value = line.slice(colon + 1)
    const semi = left.indexOf(';')
    const name = (semi === -1 ? left : left.slice(0, semi)).toUpperCase()
    const params = semi === -1 ? '' : left.slice(semi + 1)
    cur.set(name, { value, params })
  }
  return events
}
