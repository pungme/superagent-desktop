import { describe, expect, it } from 'vitest'
import { findProject } from './find-project'

const projects = ['Computer', 'superagent', 'wepush', 'wepush-portal', 'shot caller'].map(
  (name) => ({ name })
)

describe('which project someone means', () => {
  it('takes the exact name over a longer one that starts the same', () => {
    expect(findProject(projects, 'wepush').match?.name).toBe('wepush')
    expect(findProject(projects, 'WePush').match?.name).toBe('wepush')
  })
  it('takes the only one that starts with, or contains, what was said', () => {
    expect(findProject(projects, 'super').match?.name).toBe('superagent')
    expect(findProject(projects, 'portal').match?.name).toBe('wepush-portal')
    expect(findProject(projects, 'shotcaller').match?.name).toBe('shot caller')
    expect(findProject(projects, 'shot-caller').match?.name).toBe('shot caller')
  })
  it('does not guess between two, and says which they were', () => {
    const r = findProject(projects, 'wep')
    expect(r.match).toBeNull()
    expect(r.candidates.map((p) => p.name)).toEqual(['wepush', 'wepush-portal'])
  })
  it('finds nothing for nothing, or for a name that is not there', () => {
    expect(findProject(projects, '  ')).toEqual({ match: null, candidates: [] })
    expect(findProject(projects, 'zebra')).toEqual({ match: null, candidates: [] })
  })
})
