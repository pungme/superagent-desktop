import { describe, expect, it, vi } from 'vitest'
import { mayFlip, onlyTrusted, trustedSender } from './switches'

describe('who may flip the switches', () => {
  const main = {}
  const event = (
    frame: unknown = main
  ): { senderFrame: unknown; sender: { mainFrame: unknown } } => ({
    senderFrame: frame,
    sender: { mainFrame: main }
  })
  const alive = { isDestroyed: () => false }

  it("takes the main window's top frame, and nothing else", () => {
    expect(trustedSender(event(), alive, false)).toBe(true)
    // A sub-frame of the same window (an iframe, an injected one).
    expect(trustedSender(event({}), alive, false)).toBe(false)
    // The dot's window, a window that has gone, or no window at all.
    expect(trustedSender(event(), alive, true)).toBe(false)
    expect(trustedSender(event(), { isDestroyed: () => true }, false)).toBe(false)
    expect(trustedSender(event(), null, false)).toBe(false)
  })

  it('asks at the Mac before turning on, and goes only on a yes', async () => {
    const yes = vi.fn(async () => true)
    const no = vi.fn(async () => false)
    expect(await mayFlip({ trusted: true, on: true, confirm: yes })).toBe(true)
    expect(await mayFlip({ trusted: true, on: true, confirm: no })).toBe(false)
    expect(yes).toHaveBeenCalledOnce()
  })

  it('asks nothing to turn off, and nothing from someone who is not trusted, ever', async () => {
    const ask = vi.fn(async () => true)
    expect(await mayFlip({ trusted: true, on: false, confirm: ask })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect(await mayFlip({ trusted: false, on: true, confirm: ask })).toBe(false)
    expect(await mayFlip({ trusted: false, on: false, confirm: ask })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('pairing and revoking run only for the main window, and silently not at all for anyone else', () => {
    const ran: unknown[][] = []
    const trusted = (e: { senderFrame: unknown; sender: { mainFrame: unknown } }): boolean =>
      trustedSender(e, alive, false)
    const handler = onlyTrusted(trusted, (...a: unknown[]) => void ran.push(a))
    handler(event(), 'device-1')
    handler(event({}), 'device-2') // a sub-frame
    expect(ran).toEqual([['device-1']])
    const dot = onlyTrusted(
      (e: ReturnType<typeof event>) => trustedSender(e, alive, true),
      () => ran.push([])
    )
    dot(event())
    expect(ran).toHaveLength(1)
  })
})
