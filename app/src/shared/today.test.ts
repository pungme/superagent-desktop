import { describe, it, expect } from 'vitest'
import { dayNotes, pickTodos, rankTodos, TODAY_ASSISTANT_RULES, type TodoLike } from './today'

const card = (id: string, status: TodoLike['status'], updatedAt: number, ws = 'w1'): TodoLike => ({
  id,
  workspaceId: ws,
  title: `Task ${id}`,
  status,
  updatedAt
})

describe('rankTodos / pickTodos', () => {
  const cards = [
    card('old', 'todo', 1),
    card('new', 'todo', 90),
    card('doing', 'doing', 5),
    card('check', 'testing', 50),
    card('mid', 'todo', 40)
  ]
  it('puts what is in progress first, then the most recently touched', () => {
    expect(rankTodos(cards).map((c) => c.id)).toEqual(['doing', 'check', 'new', 'mid', 'old'])
  })
  it('shows a few and says how many are behind them', () => {
    const many = Array.from({ length: 361 }, (_, i) => card(`c${i}`, 'todo', i))
    const { shown, hidden } = pickTodos(many, false)
    expect(shown).toHaveLength(10)
    expect(hidden).toBe(351)
    expect(shown[0].id).toBe('c360') // the newest
    expect(pickTodos(many, true).shown).toHaveLength(361)
  })
  it('keeps everything in progress even past the limit', () => {
    const busy = Array.from({ length: 14 }, (_, i) => card(`d${i}`, 'doing', i))
    expect(pickTodos([...busy, card('t', 'todo', 99)], false).shown).toHaveLength(14)
  })
})

describe('dayNotes', () => {
  it('writes the calendar and the to-dos by project for an agent', () => {
    const text = dayNotes(
      new Date('2026-11-19T12:34:00'),
      [
        {
          title: 'Lunch with Devan',
          start: '2026-11-19T13:00',
          end: '2026-11-19T14:00',
          allDay: false,
          notes: 'Schwabing\nbring the contract'
        },
        { title: 'Birthday', start: '2026-11-19', end: null, allDay: true, notes: '' }
      ],
      [card('a', 'doing', 2, 'w1'), card('b', 'todo', 1, 'w2')],
      (ws) => (ws === 'w1' ? 'superagent' : 'wepush')
    )
    expect(text).toContain('# Today: Thursday 19 November 2026, it is 12:34')
    expect(text).toContain('- All day: Birthday')
    expect(text).toContain('- 13:00-14:00 Lunch with Devan (Schwabing)')
    expect(text).toContain('## To-dos (2 open, in progress first)')
    expect(text).toContain('### superagent\n- [doing] Task a')
    expect(text).toContain('### wepush\n- Task b')
  })
  it('says so when there is nothing on the calendar, and caps a long list', () => {
    const cards = Array.from({ length: 300 }, (_, i) => card(`c${i}`, 'todo', i))
    const text = dayNotes(new Date('2026-11-19T09:00:00'), [], cards, () => 'p', 250)
    expect(text).toContain('Nothing on the calendar today.')
    expect(text).toContain('(50 older to-dos not listed)')
  })
})

describe('TODAY_ASSISTANT_RULES', () => {
  it('sends work to the right existing conversation before starting a new one', () => {
    expect(TODAY_ASSISTANT_RULES).toContain('app_find_chats')
    expect(TODAY_ASSISTANT_RULES).toContain('app_send_message')
    expect(TODAY_ASSISTANT_RULES.indexOf('app_send_message')).toBeLessThan(
      TODAY_ASSISTANT_RULES.indexOf('app_new_chat')
    )
  })
})
