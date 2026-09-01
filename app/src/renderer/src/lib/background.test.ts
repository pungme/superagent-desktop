import { describe, it, expect } from 'vitest'
import { redirectTarget } from './background'

/**
 * A backgrounded command that redirects has a readable handle after all — the
 * file. Finding it is what gives the runs strip live output for a job that would
 * otherwise report there was nothing to read. Codex reaches for this form by
 * default (`… >/tmp/x.log 2>&1 &`), and it works for a Claude command too.
 */
describe('redirectTarget', () => {
  it('finds the file a backgrounded server logs to', () => {
    expect(redirectTarget('python3 -m http.server 8794 >/tmp/cove-http-8794.log 2>&1 &')).toBe(
      '/tmp/cove-http-8794.log'
    )
  })

  it('handles spacing, appends and quotes', () => {
    expect(redirectTarget('npm run dev > /tmp/dev.log 2>&1 &')).toBe('/tmp/dev.log')
    expect(redirectTarget('npm run dev >> /tmp/dev.log &')).toBe('/tmp/dev.log')
    expect(redirectTarget('npm run dev > "/tmp/my dev.log" &')).toBe('/tmp/my dev.log')
  })

  it('is not fooled by 2>&1, /dev/null or a relative path', () => {
    // `2>&1` duplicates a descriptor; it is not a file to read.
    expect(redirectTarget('foo 2>&1 &')).toBeUndefined()
    expect(redirectTarget('foo >/dev/null 2>&1 &')).toBeUndefined()
    // Relative to the agent's cwd, which the tail would not resolve against.
    expect(redirectTarget('foo > dev.log &')).toBeUndefined()
  })

  it('returns nothing for a command that does not redirect', () => {
    expect(redirectTarget('npm run dev &')).toBeUndefined()
    expect(redirectTarget('ls -la')).toBeUndefined()
  })
})
