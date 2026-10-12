import { describe, expect, it, vi } from 'vitest'
import { within } from './promise-timeout'

describe('bounded external work', () => {
  it('returns work that finishes before its deadline', async () => {
    await expect(within(Promise.resolve('done'), 100, 'late')).resolves.toBe('done')
  })

  it('rejects work that never settles', async () => {
    vi.useFakeTimers()
    const result = within(new Promise<string>(() => {}), 5_000, 'Screen capture timed out.')
    const expected = expect(result).rejects.toThrow('Screen capture timed out.')
    await vi.advanceTimersByTimeAsync(5_000)
    await expected
    vi.useRealTimers()
  })
})
