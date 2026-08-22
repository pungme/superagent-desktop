import { describe, it, expect } from 'vitest'
import { parseICS } from './ics'

const wrap = (body: string): string =>
  `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n${body}\nEND:VCALENDAR\n`

describe('parseICS', () => {
  it('reads a timed event with floating (local) time', () => {
    const ics = wrap(
      [
        'BEGIN:VEVENT',
        'SUMMARY:Standup',
        'DTSTART:20260804T090000',
        'DTEND:20260804T093000',
        'DESCRIPTION:Daily sync',
        'END:VEVENT'
      ].join('\n')
    )
    expect(parseICS(ics)).toEqual([
      { title: 'Standup', start: '2026-08-04T09:00', end: '2026-08-04T09:30', allDay: false, notes: 'Daily sync' }
    ])
  })

  it('reads an all-day event and collapses the exclusive DTEND', () => {
    const ics = wrap(
      [
        'BEGIN:VEVENT',
        'SUMMARY:Holiday',
        'DTSTART;VALUE=DATE:20261225',
        'DTEND;VALUE=DATE:20261226',
        'END:VEVENT'
      ].join('\n')
    )
    expect(parseICS(ics)).toEqual([
      { title: 'Holiday', start: '2026-12-25', end: '2026-12-25', allDay: true, notes: '' }
    ])
  })

  it('unfolds wrapped lines and unescapes text', () => {
    const ics = wrap(
      [
        'BEGIN:VEVENT',
        'SUMMARY:Long meeting about the ',
        ' Q3 roadmap\\, part 2',
        'DTSTART:20260101T140000',
        'DESCRIPTION:line one\\nline two',
        'END:VEVENT'
      ].join('\n')
    )
    const [e] = parseICS(ics)
    expect(e.title).toBe('Long meeting about the Q3 roadmap, part 2')
    expect(e.notes).toBe('line one\nline two')
  })

  it('parses many events and skips ones with no start', () => {
    const ics = wrap(
      [
        'BEGIN:VEVENT\nSUMMARY:A\nDTSTART:20260101T100000\nEND:VEVENT',
        'BEGIN:VEVENT\nSUMMARY:NoStart\nEND:VEVENT',
        'BEGIN:VEVENT\nSUMMARY:B\nDTSTART;VALUE=DATE:20260102\nEND:VEVENT'
      ].join('\n')
    )
    const events = parseICS(ics)
    expect(events.map((e) => e.title)).toEqual(['A', 'B'])
  })

  it('falls back to a title when SUMMARY is missing', () => {
    const ics = wrap('BEGIN:VEVENT\nDTSTART:20260101T100000\nEND:VEVENT')
    expect(parseICS(ics)[0].title).toBe('Untitled event')
  })

  it('converts a UTC (Z) time to a local wall-clock string', () => {
    const ics = wrap('BEGIN:VEVENT\nSUMMARY:Z\nDTSTART:20260804T090000Z\nEND:VEVENT')
    const [e] = parseICS(ics)
    // Exact hour depends on the runner's zone, but it must be a timed local string.
    expect(e.allDay).toBe(false)
    expect(e.start).toMatch(/^2026-08-0[34]T\d{2}:\d{2}$/)
  })

  it('returns nothing for a document with no events', () => {
    expect(parseICS('BEGIN:VCALENDAR\nEND:VCALENDAR')).toEqual([])
  })
})
