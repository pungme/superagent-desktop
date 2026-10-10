import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn() },
  desktopCapturer: {},
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  ipcMain: { handle: vi.fn() },
  screen: {},
  shell: {},
  systemPreferences: {}
}))
vi.mock('./store', () => ({ kvGet: () => undefined, kvSet: vi.fn() }))
vi.mock('./util', () => ({ broadcastToWindows: vi.fn() }))

const { cuseArgs, grantConsent, hasConsent, notReady, setComputerStop, stopComputerUse } =
  await import('./computer-use')
const { CONSENT_IDLE_MS } = await import('../shared/computer-use')

const shot = { width: 1440, height: 931, area: { x: 0, y: 0, width: 1728, height: 1117 } }

describe('an action, as what the helper is asked to do', () => {
  it('maps a point on the screenshot onto the screen', () => {
    expect(cuseArgs({ type: 'click', x: 720, y: 465 }, shot)).toEqual([
      'click',
      '864',
      '558',
      'left',
      '1'
    ])
    expect(cuseArgs({ type: 'click', x: 10, y: 10, button: 'right', count: 2 }, shot)).toEqual([
      'click',
      '12',
      '12',
      'right',
      '2'
    ])
    expect(cuseArgs({ type: 'drag', x: 0, y: 0, toX: 1440, toY: 931 }, shot)).toEqual([
      'drag',
      '0',
      '0',
      '1728',
      '1117'
    ])
    expect(cuseArgs({ type: 'scroll', x: 100, y: 100, dx: 0, dy: -5 }, shot).slice(-2)).toEqual([
      '0',
      '-5'
    ])
  })

  it('passes text and keys through untouched, as one argument each', () => {
    // Whatever is in it: it is an argument to a program, never a shell line.
    expect(cuseArgs({ type: 'type', text: 'hi"; rm -rf ~ #' }, undefined)).toEqual([
      'type',
      'hi"; rm -rf ~ #'
    ])
    expect(cuseArgs({ type: 'key', keys: 'Cmd+Shift+4' }, undefined)).toEqual([
      'key',
      'cmd+shift+4'
    ])
  })

  it('will not point at anything before there is a screenshot to point on', () => {
    expect(() => cuseArgs({ type: 'click', x: 1, y: 1 }, undefined)).toThrow(/screenshot first/)
  })

  it('will not click outside the picture', () => {
    expect(() => cuseArgs({ type: 'click', x: 5000, y: 10 }, shot)).toThrow(
      /outside the screenshot/
    )
  })
})

describe('being allowed to use the Mac', () => {
  it('holds for a conversation while it is working, and lapses when it goes quiet', () => {
    expect(hasConsent('chat-a', 1000)).toBe(false)
    grantConsent('chat-a', 1000)
    expect(hasConsent('chat-a', 1000 + CONSENT_IDLE_MS - 1)).toBe(true)
    expect(hasConsent('chat-a', 1000 + CONSENT_IDLE_MS + 1)).toBe(false)
    // One conversation's yes is not another's.
    expect(hasConsent('chat-b', 1001)).toBe(false)
  })

  it('stopping withdraws every yes and tells each agent to stop', () => {
    const stopped: string[] = []
    setComputerStop((id) => stopped.push(id))
    grantConsent('chat-a')
    grantConsent('chat-b')
    expect(stopComputerUse().sort()).toEqual(['chat-a', 'chat-b'])
    expect(stopped.sort()).toEqual(['chat-a', 'chat-b'])
    expect(hasConsent('chat-a')).toBe(false)
    expect(hasConsent('chat-b')).toBe(false)
  })
})

describe('what is missing, in words for the user', () => {
  const ready = { supported: true, enabled: true, screen: true, accessibility: true, helper: true }
  it('is nothing when it is all there', () => {
    expect(notReady(ready)).toBeNull()
  })
  it('says it is off before anything about permissions', () => {
    expect(notReady({ ...ready, enabled: false, screen: false })).toContain('turned off')
  })
  it('names the permission that is missing, and both when both are', () => {
    expect(notReady({ ...ready, screen: false })).toContain('Screen Recording')
    expect(notReady({ ...ready, screen: false })).not.toContain('Accessibility (')
    const both = notReady({ ...ready, screen: false, accessibility: false })!
    expect(both).toContain('Screen Recording')
    expect(both).toContain('Accessibility')
  })
})
