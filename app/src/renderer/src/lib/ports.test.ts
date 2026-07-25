import { describe, it, expect } from 'vitest'
import { extractPorts } from './ports'

describe('extractPorts', () => {
  it('extracts a Vite local URL', () => {
    expect(extractPorts('  ➜  Local:   http://localhost:5173/')).toEqual([5173])
  })

  it('extracts a Next.js url', () => {
    expect(extractPorts('- Local:        http://localhost:3000')).toEqual([3000])
  })

  it('handles 127.0.0.1', () => {
    expect(extractPorts('Server running at http://127.0.0.1:8080')).toEqual([8080])
  })

  it('dedupes repeated ports in one chunk', () => {
    expect(extractPorts('localhost:3000 and again localhost:3000')).toEqual([3000])
  })

  it('finds multiple distinct ports', () => {
    expect(extractPorts('localhost:3000 localhost:4000')).toEqual([3000, 4000])
  })

  it('ignores privileged/low ports', () => {
    expect(extractPorts('localhost:80 localhost:443')).toEqual([])
  })

  it('returns empty for no match', () => {
    expect(extractPorts('just some regular terminal output')).toEqual([])
  })
})
