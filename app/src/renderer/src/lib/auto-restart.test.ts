import { describe, it, expect } from 'vitest'
import { AUTO_RESTART_MAX, shouldAutoRestart } from './auto-restart'

describe('shouldAutoRestart', () => {
  it('restarts a session that ended, a few times', () => {
    expect(shouldAutoRestart(0)).toBe(true)
    expect(shouldAutoRestart(AUTO_RESTART_MAX - 1)).toBe(true)
  })
  it('stops once it keeps dying, so the banner can say so', () => {
    expect(shouldAutoRestart(AUTO_RESTART_MAX)).toBe(false)
  })
})
