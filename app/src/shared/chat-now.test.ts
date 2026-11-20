import { describe, expect, it } from 'vitest'
import { chatNow, liveLine } from './chat-now'

describe('chatNow', () => {
  it('adds a second sentence when the first is too short to say anything', () => {
    expect(chatNow('Fixed. The nav wrapped under 400 px and pushed the logo off the screen.')).toBe(
      'Fixed. The nav wrapped under 400 px and pushed the logo off the screen'
    )
  })
  it('takes the markdown out', () => {
    expect(chatNow('I changed **`Sidebar.tsx`** and [the docs](https://x.y) to match this.')).toBe(
      'I changed Sidebar.tsx and the docs to match this'
    )
  })
  it('skips a code block or heading and reads the first paragraph with words', () => {
    expect(
      chatNow('```ts\nconst a = 1\n```\n\nThe build passes now, all 340 tests are green.')
    ).toBe('The build passes now, all 340 tests are green')
    expect(chatNow('## Result\n\nAll set, the page loads in 90 ms.')).toBe(
      'All set, the page loads in 90 ms'
    )
  })
  it('cuts a long line at a word, with an ellipsis, within the limit', () => {
    const out = chatNow(
      'The deploy is waiting on the migration that adds the new index to the campaigns table so the dashboard can stop timing out.'
    )
    expect(out.length).toBeLessThanOrEqual(90)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/\s…$/)
  })
  it('is empty for nothing', () => {
    expect(chatNow('')).toBe('')
    expect(chatNow('```\nonly code\n```')).toBe('')
  })
})

describe('liveLine', () => {
  it("uses the step's own description, never the raw command", () => {
    expect(
      liveLine([
        { kind: 'user' },
        {
          kind: 'tool',
          verb: 'Terminal',
          about: 'Build the app bundle',
          target: './scripts/build-app.sh'
        }
      ])
    ).toBe('Build the app bundle')
    expect(liveLine([{ kind: 'user' }, { kind: 'tool', verb: 'Terminal' }])).toBe(
      'Running a command'
    )
  })
  it('otherwise says what the agent said it is about to do', () => {
    expect(
      liveLine([
        { kind: 'user' },
        { kind: 'say', text: 'The badge now sits cleanly above the ring. Merging to main:' },
        { kind: 'tool', verb: 'Terminal' }
      ])
    ).toBe('Merging to main')
  })
  it('only looks at this turn', () => {
    expect(
      liveLine([
        { kind: 'say', text: 'Old news from the last turn.' },
        { kind: 'user' },
        { kind: 'tool', verb: 'Editing', target: 'Sidebar.tsx' }
      ])
    ).toBe('Editing Sidebar.tsx')
    expect(liveLine([{ kind: 'say', text: 'x.' }, { kind: 'user' }])).toBe('Reading what you asked')
    expect(liveLine([{ kind: 'user' }, { kind: 'think' }])).toBe('Thinking')
  })
  it('keeps it to one short line', () => {
    const long =
      'I am going to go through every single page of the portal and check each table, then the filters, then the exports'
    const out = liveLine([{ kind: 'user' }, { kind: 'say', text: long }])
    expect(out.length).toBeLessThanOrEqual(90)
    expect(out.endsWith('…')).toBe(true)
  })
})
