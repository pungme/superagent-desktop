import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const h = vi.hoisted(() => ({ sent: [] as { ch: string; p: unknown }[] }))
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('./store', () => ({ getDb: () => new Database(':memory:') }))
vi.mock('./util', () => ({
  broadcastToWindows: (ch: string, p: unknown) => h.sent.push({ ch, p })
}))

const c = await import('./contacts')

describe('a project’s contacts', () => {
  beforeEach(() => {
    c._useDbForTests(new Database(':memory:'))
    h.sent.length = 0
  })

  it('adds, lists per project, and tells the windows', () => {
    const a = c.addContact('w1', {
      name: ' Studio café ',
      email: 'Info@Studio.example',
      ask: 'Crew food'
    })!
    c.addContact('w2', { name: 'Elsewhere' })
    expect(a).toMatchObject({
      name: 'Studio café',
      email: 'info@studio.example',
      status: 'not_sent'
    })
    expect(a.history[0]).toMatchObject({ text: 'Added', by: 'you' })
    expect(c.listContacts('w1').map((x) => x.name)).toEqual(['Studio café'])
    expect(h.sent).toContainEqual({ ch: 'contacts:changed', p: { workspaceId: 'w1' } })
  })

  it('needs a name', () => {
    expect(c.addContact('w1', { email: 'x@y.de' })).toBeNull()
    expect(c.addContact('w1', { name: '   ' })).toBeNull()
  })

  it('records a change of status in its history, and a reply as being in touch', () => {
    const a = c.addContact('w1', { name: 'Max' })!
    const b = c.updateContact(
      a.id,
      { status: 'replied' },
      'agent',
      'Said yes in principle, wants a call'
    )!
    expect(b.status).toBe('replied')
    expect(b.lastContactAt).not.toBeNull()
    expect(b.history.slice(-2).map((e) => [e.by, e.text])).toEqual([
      ['agent', 'Status: replied'],
      ['agent', 'Said yes in principle, wants a call']
    ])
  })

  it('reads statuses and days leniently and ignores nonsense', () => {
    const a = c.addContact('w1', { name: 'Max', status: 'waiting', followUp: '2 Dec 2026' })!
    expect(a.status).toBe('sent')
    expect(a.followUp).toBe('2026-12-02')
    const b = c.updateContact(a.id, { status: 'banana', name: '' })!
    expect(b.status).toBe('sent')
    expect(b.name).toBe('Max')
  })

  it('an email to a contact marks them waiting with a follow-up a week out', () => {
    const a = c.addContact('w1', { name: 'Studio café', email: 'info@studio.example' })
    c.addContact('w1', { name: 'Other', email: 'other@x.example' })
    c.addContact('w2', { name: 'Same address, other project', email: 'info@studio.example' })
    const now = new Date(2026, 10, 25, 10).getTime()
    const touched = c.noteEmailSent(
      'w1',
      ['Studio <INFO@studio.example>'],
      'Crew food in January',
      now
    )
    expect(touched).toEqual(['Studio café'])
    const after = c.getContact(a!.id)!
    expect(after).toMatchObject({ status: 'sent', lastContactAt: now, followUp: '2026-12-02' })
    expect(after.history.at(-1)).toMatchObject({
      by: 'mail',
      text: 'Email sent: Crew food in January'
    })
    // The other project's contact is not touched.
    expect(c.listContacts('w2')[0].status).toBe('not_sent')
    expect(c.noteEmailSent('w1', ['nobody@x.example'], 's')).toEqual([])
  })

  it('lists every project’s due follow-ups for Today', () => {
    c.addContact('w1', { name: 'Due', status: 'sent', followUp: '2026-11-20' })
    c.addContact('w2', { name: 'Also due', status: 'not_sent', followUp: '2026-11-25' })
    c.addContact('w1', { name: 'Later', status: 'sent', followUp: '2026-12-20' })
    c.addContact('w1', { name: 'Answered', status: 'yes', followUp: '2026-11-01' })
    expect(c.dueContacts('2026-11-25').map((x) => x.name)).toEqual(['Due', 'Also due'])
  })

  it('finds a contact by id, email or exact name, within the project', () => {
    const a = c.addContact('w1', { name: 'Max Wagner', email: 'max@x.example' })!
    expect(c.findContact('w1', a.id)?.id).toBe(a.id)
    expect(c.findContact('w1', 'MAX@x.example')?.id).toBe(a.id)
    expect(c.findContact('w1', 'max wagner')?.id).toBe(a.id)
    expect(c.findContact('w2', a.id)).toBeNull()
  })

  it('deletes', () => {
    const a = c.addContact('w1', { name: 'Gone' })!
    expect(c.deleteContact(a.id)).toBe(true)
    expect(c.listContacts('w1')).toEqual([])
    expect(c.deleteContact(a.id)).toBe(false)
  })
})
