import { describe, expect, it } from 'vitest'
import { forbiddenSwitch, testOnlyEnv } from './harden'

describe('what the released app refuses to be started with', () => {
  it('a debugging port, an inspector, or a data folder of the starter’s choosing', () => {
    const app = '/Applications/SuperAgent.app/Contents/MacOS/SuperAgent'
    expect(forbiddenSwitch([app])).toBeNull()
    expect(forbiddenSwitch([app, '-psn_0_12345'])).toBeNull()
    expect(forbiddenSwitch([app, '--remote-debugging-port=9333'])).toBe(
      '--remote-debugging-port=9333'
    )
    expect(forbiddenSwitch([app, '--inspect'])).toBe('--inspect')
    expect(forbiddenSwitch([app, '--inspect-brk=0'])).toBe('--inspect-brk=0')
    expect(forbiddenSwitch([app, '--user-data-dir=/tmp/x'])).toBe('--user-data-dir=/tmp/x')
    // Its own name is not a switch, whatever it is called.
    expect(forbiddenSwitch(['--inspect'])).toBeNull()
  })

  it('the variables tests use, and no others', () => {
    expect(
      testOnlyEnv({
        COVE_USER_DATA: '/tmp/x',
        COVE_E2E_QUIET: '1',
        COVE_E2E_AX_PID: '4',
        COVE_REMOTE_DEBUG: '1',
        COVE_RELAY_URL: 'wss://x',
        PATH: '/usr/bin',
        HOME: '/Users/me'
      }).sort()
    ).toEqual(['COVE_E2E_AX_PID', 'COVE_E2E_QUIET', 'COVE_REMOTE_DEBUG', 'COVE_USER_DATA'])
  })
})
