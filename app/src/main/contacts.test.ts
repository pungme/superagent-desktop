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

  describe('the project’s own fields', () => {
    it('a new field is defined by being used, on the contact and on the project', () => {
      const a = c.addContact('w1', {
        name: 'Art foundation',
        fields: { Budget: '€18,000', Country: 'Germany' }
      })!
      expect(a.fields).toEqual({ budget: '€18,000', country: 'Germany' })
      expect(c.listFields('w1')).toEqual([
        { key: 'budget', label: 'Budget', type: 'number' },
        { key: 'country', label: 'Country', type: 'text' }
      ])
      // Another project does not get them.
      expect(c.listFields('w2')).toEqual([])
    })

    it('the same label is the same field, whatever its case', () => {
      c.addContact('w1', { name: 'A', fields: { Budget: '1' } })
      const b = c.addContact('w1', { name: 'B', fields: { budget: '2', 'BUDGET ': '3' } })!
      expect(c.listFields('w1')).toHaveLength(1)
      expect(b.fields.budget).toBe('3')
    })

    it('updates one field and leaves the others; an empty value clears it', () => {
      const a = c.addContact('w1', { name: 'A', fields: { Budget: '5k', Country: 'DE' } })!
      const b = c.updateContact(a.id, { fields: { Budget: '6k' } })!
      expect(b.fields).toEqual({ budget: '6k', country: 'DE' })
      const d = c.updateContact(a.id, { fields: { Country: '' } })!
      expect(d.fields).toEqual({ budget: '6k' })
      // Still a field of the project, ready to be filled in.
      expect(c.listFields('w1').map((f) => f.key)).toContain('country')
    })

    it('updating without fields leaves them alone', () => {
      const a = c.addContact('w1', { name: 'A', fields: { Budget: '5k' } })!
      expect(c.updateContact(a.id, { ask: 'Crew food' })!.fields).toEqual({ budget: '5k' })
    })

    it('removing a field takes it off every contact', () => {
      const a = c.addContact('w1', { name: 'A', fields: { Budget: '5k', Country: 'DE' } })!
      const b = c.addContact('w1', { name: 'B', fields: { Budget: '7k' } })!
      expect(c.removeField('w1', 'budget')).toBe(true)
      expect(c.getContact(a.id)!.fields).toEqual({ country: 'DE' })
      expect(c.getContact(b.id)!.fields).toEqual({})
      expect(c.listFields('w1').map((f) => f.key)).toEqual(['country'])
      expect(c.removeField('w1', 'budget')).toBe(false)
    })

    it('a label that is not a name for a field is ignored, and so is a value that is too long', () => {
      const a = c.addContact('w1', { name: 'A', fields: { '???': 'x', Notes2: 'y'.repeat(900) } })!
      expect(Object.keys(a.fields)).toEqual(['notes2'])
      expect(a.fields.notes2).toHaveLength(500)
    })

    it('a project can only have so many fields', () => {
      const many: Record<string, string> = {}
      for (let i = 0; i < 30; i++) many[`Field ${i}`] = 'x'
      const a = c.addContact('w1', { name: 'A', fields: many })!
      expect(c.listFields('w1')).toHaveLength(24)
      expect(Object.keys(a.fields)).toHaveLength(24)
    })

    it('a label that matches a built-in gets a name of its own', () => {
      const a = c.addContact('w1', { name: 'A', status: 'yes', fields: { Status: 'on hold' } })!
      expect(a.status).toBe('yes')
      expect(a.fields).toEqual({ status_2: 'on hold' })
    })

    it('a database from before fields existed gains the column', () => {
      const old = new Database(':memory:')
      old.exec(
        "CREATE TABLE contacts (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, name TEXT NOT NULL, org TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', ask TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'not_sent', lastContactAt INTEGER, followUp TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', history TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)"
      )
      old
        .prepare(
          "INSERT INTO contacts (id, workspaceId, name, createdAt, updatedAt) VALUES ('o', 'w1', 'Old one', 1, 1)"
        )
        .run()
      c._useDbForTests(old)
      expect(c.listContacts('w1')[0]).toMatchObject({ name: 'Old one', fields: {} })
    })
  })
})
