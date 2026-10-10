import { describe, expect, it } from 'vitest'
import { goBack, visited } from './visit-history'

const v = (workspaceId: string, chatId = ''): { workspaceId: string; chatId: string } => ({
  workspaceId,
  chatId
})

describe('where the user has been', () => {
  it('records each place once, however long it stays on screen', () => {
    let h = visited([], v('a', '1'))
    h = visited(h, v('a', '1'))
    h = visited(h, v('a', '2'))
    h = visited(h, v('b', '9'))
    expect(h).toEqual([v('a', '1'), v('a', '2'), v('b', '9')])
    expect(visited(h, v(''))).toBe(h)
  })
  it('goes back to the place before, and again to the one before that', () => {
    const h = [v('a', '1'), v('a', '2'), v('b', '9')]
    const once = goBack(h)!
    expect(once.to).toEqual(v('a', '2'))
    const twice = goBack(once.history)!
    expect(twice.to).toEqual(v('a', '1'))
    expect(goBack(twice.history)).toBeNull()
    expect(goBack([])).toBeNull()
  })
  it('keeps only the most recent places', () => {
    let h: ReturnType<typeof visited> = []
    for (let i = 0; i < 50; i++) h = visited(h, v('a', String(i)))
    expect(h).toHaveLength(30)
    expect(h[0].chatId).toBe('20')
  })
})
