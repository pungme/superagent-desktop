import { expect, it, vi } from 'vitest'

vi.mock('./store', () => ({
  DESKTOP_WORKSPACE_ID: '__desktop_chat__',
  getTree: () => [],
  lastUsedByWorkspace: () => ({})
}))
const { orderDotProjects } = await import('./dot-projects')

const p = (id: string, name = id): { id: string; name: string; kind: string; path: string } => ({
  id,
  name,
  kind: 'folder',
  path: `/p/${id}`
})

it('puts the Computer first, then pinned projects, then the most recently used', () => {
  const got = orderDotProjects([p('old'), p('recent'), p('pinned'), p('never')], {
    old: { usedAt: 100, pinned: false },
    recent: { usedAt: 900, pinned: false },
    pinned: { usedAt: 50, pinned: true }
  })
  expect(got.map((x) => x.id)).toEqual(['__desktop_chat__', 'pinned', 'recent', 'old', 'never'])
  expect(got[0]).toMatchObject({ name: 'Computer', kind: 'computer' })
})

it('orders projects nobody has used by name, so the list does not shuffle', () => {
  expect(orderDotProjects([p('b', 'Beta'), p('a', 'alpha')], {}).map((x) => x.name)).toEqual([
    'Computer',
    'alpha',
    'Beta'
  ])
})
