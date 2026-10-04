import { describe, it, expect } from 'vitest'
import { withoutAgentNudge } from './agent-nudge'

describe('withoutAgentNudge', () => {
  it("takes the CLI's quiet-turn nudge off the front of a reply", () => {
    const nudge =
      "The user hasn't heard from you in a while — say in a few words what you're doing, then continue."
    expect(withoutAgentNudge(nudge)).toBe('')
    expect(withoutAgentNudge(`${nudge}\n\nStill building the footer.`)).toBe(
      'Still building the footer.'
    )
  })

  it('leaves everything else alone, the same words mid-reply included', () => {
    expect(withoutAgentNudge('Done.')).toBe('Done.')
    expect(withoutAgentNudge("Quote: The user hasn't heard from you in a while — say…")).toContain(
      'Quote:'
    )
  })
})
