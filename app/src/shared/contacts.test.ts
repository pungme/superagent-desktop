import { describe, it, expect } from 'vitest'
import {
  addDays,
  addresses,
  fieldKey,
  guessFieldType,
  afterEmail,
  isDue,
  matches,
  sortContacts,
  summarize,
  toDay,
  toStatus,
  type Contact
} from './contacts'

const base = (over: Partial<Contact>): Contact => ({
  id: over.name ?? 'x',
  workspaceId: 'w',
  name: 'Someone',
  org: '',
  email: '',
  channel: '',
  ask: '',
  status: 'not_sent',
  lastContactAt: null,
  followUp: '',
  notes: '',
  fields: {},
  history: [],
  createdAt: 0,
  updatedAt: 0,
  ...over
})

describe('contacts', () => {
  it('reads statuses the way people and agents write them', () => {
    expect(toStatus('Not sent')).toBe('not_sent')
    expect(toStatus('waiting')).toBe('sent')
    expect(toStatus('follow-up')).toBe('sent')
    expect(toStatus('✓')).toBe('yes')
    expect(toStatus('declined')).toBe('no')
    expect(toStatus('replied')).toBe('replied')
    expect(toStatus('banana')).toBeNull()
  })

  it('reads days in the usual shapes', () => {
    expect(toDay('2026-12-01')).toBe('2026-12-01')
    expect(toDay('1 Dec 2026')).toBe('2026-12-01')
    expect(toDay('')).toBe('')
    expect(toDay('soon')).toBe('')
  })

  it('is due when the follow-up day has come and nobody answered yet', () => {
    expect(isDue(base({ status: 'sent', followUp: '2026-11-25' }), '2026-11-25')).toBe(true)
    expect(isDue(base({ status: 'sent', followUp: '2026-11-20' }), '2026-11-25')).toBe(true)
    expect(isDue(base({ status: 'sent', followUp: '2026-11-26' }), '2026-11-25')).toBe(false)
    expect(isDue(base({ status: 'replied', followUp: '2026-11-20' }), '2026-11-25')).toBe(false)
    expect(isDue(base({ status: 'yes', followUp: '2026-11-20' }), '2026-11-25')).toBe(false)
    expect(isDue(base({ status: 'sent', followUp: '' }), '2026-11-25')).toBe(false)
  })

  it('filters by status, due and words', () => {
    const c = base({
      name: 'Studio café',
      status: 'sent',
      followUp: '2026-11-20',
      ask: 'Crew food'
    })
    expect(matches(c, 'due', '2026-11-25')).toBe(true)
    expect(matches(c, 'sent', '2026-11-25')).toBe(true)
    expect(matches(c, 'yes', '2026-11-25')).toBe(false)
    expect(matches(c, 'all', '2026-11-25', 'crew')).toBe(true)
    expect(matches(c, 'all', '2026-11-25', 'venue')).toBe(false)
  })

  it('puts due first, oldest first, then replied, waiting, not sent, yes, no', () => {
    const list = [
      base({ name: 'No', status: 'no' }),
      base({ name: 'Yes', status: 'yes' }),
      base({ name: 'New', status: 'not_sent' }),
      base({ name: 'Waiting', status: 'sent', followUp: '2026-12-09' }),
      base({ name: 'Due later', status: 'sent', followUp: '2026-11-24' }),
      base({ name: 'Due first', status: 'sent', followUp: '2026-11-18' }),
      base({ name: 'Replied', status: 'replied' })
    ]
    expect(sortContacts(list, '2026-11-25').map((c) => c.name)).toEqual([
      'Due first',
      'Due later',
      'Replied',
      'Waiting',
      'New',
      'Yes',
      'No'
    ])
  })

  it('counts each status and what is due', () => {
    const s = summarize(
      [
        base({ status: 'sent', followUp: '2026-11-20' }),
        base({ status: 'sent' }),
        base({ status: 'yes' })
      ],
      '2026-11-25'
    )
    expect(s).toMatchObject({ all: 3, due: 1, sent: 2, yes: 1, no: 0 })
  })

  describe('after an email goes to a contact', () => {
    const now = new Date(2026, 10, 25, 12).getTime()

    it('waits on them, contacted now, follow-up in a week', () => {
      const r = afterEmail(base({ status: 'not_sent' }), now, 'Crew food in January')
      expect(r.status).toBe('sent')
      expect(r.lastContactAt).toBe(now)
      expect(r.followUp).toBe(addDays(now, 7))
      expect(r.followUp).toBe('2026-12-02')
      expect(r.event).toEqual({ at: now, by: 'mail', text: 'Email sent: Crew food in January' })
    })

    it('keeps a later follow-up already set', () => {
      expect(afterEmail(base({ followUp: '2026-12-20' }), now, '').followUp).toBe('2026-12-20')
    })

    it('a yes or no stays as it is', () => {
      const r = afterEmail(base({ status: 'yes', followUp: '' }), now, 'Thanks!')
      expect(r.status).toBe('yes')
      expect(r.followUp).toBe('')
    })

    it('a contact who replied stays replied', () => {
      expect(afterEmail(base({ status: 'replied' }), now, 'Re: hi').status).toBe('replied')
    })
  })

  it('finds addresses in To and Cc fields', () => {
    expect(addresses('Ann Lee <Ann@Example.org>, bob@y.com')).toEqual([
      'ann@example.org',
      'bob@y.com'
    ])
    expect(addresses(['x@a.de', 'Y <y@b.de>'])).toEqual(['x@a.de', 'y@b.de'])
    expect(addresses(undefined)).toEqual([])
  })

  describe('the project’s own fields', () => {
    it('turns a label into a stable key', () => {
      expect(fieldKey('Budget')).toBe('budget')
      expect(fieldKey('Budget (€)')).toBe('budget')
      expect(fieldKey('Déadline für Förderung')).toBe('deadline_fur_forderung')
      expect(fieldKey('  ')).toBe('')
      expect(fieldKey('???')).toBe('')
    })

    it('never collides with a built-in field', () => {
      expect(fieldKey('Name')).toBe('name_2')
      expect(fieldKey('Status')).toBe('status_2')
      expect(fieldKey('Follow up')).toBe('follow_up_2')
    })

    it('guesses what a value is', () => {
      expect(guessFieldType('https://example.org/apply')).toBe('url')
      expect(guessFieldType('2026-12-15')).toBe('date')
      expect(guessFieldType('€18,000')).toBe('number')
      expect(guessFieldType('18k')).toBe('number')
      expect(guessFieldType('Germany')).toBe('text')
    })

    it('searches them too', () => {
      const c = base({ name: 'Art foundation', fields: { country: 'Germany', budget: '€18,000' } })
      expect(matches(c, 'all', '2026-11-25', 'germany')).toBe(true)
      expect(matches(c, 'all', '2026-11-25', '18,000')).toBe(true)
      expect(matches(c, 'all', '2026-11-25', 'france')).toBe(false)
    })
  })
})
