import { describe, it, expect } from 'vitest'
import {
  autoTitle,
  buildManifest,
  conductorPrompt,
  overlaps,
  parseTicketRef,
  ticketLabel
} from './conductor'

describe('conductor helpers', () => {
  it('writes and reads ticket numbers', () => {
    expect(ticketLabel(101)).toBe('#101')
    expect(parseTicketRef('#101')).toBe(101)
    expect(parseTicketRef(' 102 ')).toBe(102)
    expect(parseTicketRef('ticket 7')).toBe(7)
    expect(parseTicketRef('session #44')).toBe(44)
    expect(parseTicketRef('fix 101')).toBeNull()
    expect(parseTicketRef('')).toBeNull()
  })

  it('makes a short title from the first words of a task', () => {
    expect(autoTitle('Fix the header on mobile.')).toBe('Fix the header on mobile')
    expect(autoTitle('  Add dark mode\nand more detail below')).toBe('Add dark mode')
    const long = autoTitle(
      'Investigate why the staging deploy keeps failing on the image build step every night'
    )
    expect(long.length).toBeLessThanOrEqual(49)
    expect(long.endsWith('…')).toBe(true)
  })

  it('lists live sessions one line each and counts the closed', () => {
    const text = buildManifest({
      project: 'wepush',
      routing: 'confirm',
      sessions: [
        {
          chatId: 'a',
          title: 'Fix header',
          ticket: 101,
          summary: 'Waiting for review',
          status: 'idle',
          updatedAt: 1,
          branch: 'fix/header',
          unmerged: 2
        },
        {
          chatId: 'b',
          title: 'Pricing page',
          ticket: 102,
          summary: '',
          status: 'working',
          updatedAt: 2
        },
        { chatId: 'c', title: 'Old', ticket: 100, summary: '', status: 'closed', updatedAt: 0 }
      ],
      unlinked: [{ chatId: 'd', title: 'Scratch' }]
    })
    expect(text).toContain('Routing: Confirm')
    expect(text).toContain(
      '- #101 · Fix header · Idle · branch fix/header (2 unmerged) · Waiting for review'
    )
    expect(text).toContain('- #102 · Pricing page · Working')
    expect(text).not.toContain('Old ·')
    expect(text).toContain('1 closed')
    expect(text).toContain('Chats not connected to Main: Scratch.')
  })

  it('tells the Conductor how to title a session', () => {
    expect(conductorPrompt('auto')).toContain('three to six words')
    expect(conductorPrompt('auto')).toContain('WD-284')
  })

  it('tells Main about the per-message state and its saved memory', () => {
    const p = conductorPrompt('confirm')
    expect(p).toContain('[Conductor state]')
    expect(p).toContain('conductor_remember')
    expect(p).toContain('conductor_recall')
    expect(p).toContain('data structures')
  })

  it('says which routing mode applies', () => {
    expect(conductorPrompt('confirm')).toContain('Routing is Confirm')
    expect(conductorPrompt('auto')).toContain('Routing is Auto')
  })
})

describe('overlap between sessions', () => {
  const mk = (ticket: number, files: string[], status: 'working' | 'closed' = 'working') =>
    ({
      chatId: `c${ticket}`,
      title: `T${ticket}`,
      ticket,
      summary: '',
      status,
      updatedAt: 0,
      files
    }) as never
  it('names the files two live sessions both change', () => {
    const s = [mk(101, ['a.ts', 'b.ts']), mk(102, ['b.ts', 'c.ts']), mk(103, ['z.ts'])]
    const o = overlaps(s)
    expect(o).toHaveLength(1)
    expect(o[0].files).toEqual(['b.ts'])
    const text = buildManifest({ project: 'P', routing: 'confirm', sessions: s, unlinked: [] })
    expect(text).toContain('Overlap: #101 and #102 both change b.ts')
    expect(text).toContain('touches a.ts, b.ts')
  })
  it('ignores closed sessions', () => {
    expect(overlaps([mk(101, ['a.ts']), mk(102, ['a.ts'], 'closed')])).toHaveLength(0)
  })
  it('tells Main not to start a parallel session on the same files', () => {
    expect(conductorPrompt('auto')).toContain('same files')
  })
})
