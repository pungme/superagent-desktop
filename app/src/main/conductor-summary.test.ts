import { describe, it, expect, vi } from 'vitest'

vi.mock('./store', () => ({}))
vi.mock('./util', () => ({ broadcastToWindows: () => undefined }))
vi.mock('./prompts', () => ({ setConductorProbe: () => undefined }))
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))

const { summaryOf } = await import('./conductor-tools')

describe('the one-line summary of a worker’s reply', () => {
  it('is the first sentence, without Markdown or code', () => {
    expect(
      summaryOf('**Fixed.** The nav wrapped under 400 px and pushed the logo off. More below.')
    ).toBe('Fixed. The nav wrapped under 400 px and pushed the logo off.')
    expect(
      summaryOf('```css\n.nav { }\n```\nDone: the footer is stacked now. Anything else?')
    ).toBe('Done: the footer is stacked now.')
  })
  it('cuts a very long sentence', () => {
    const s = summaryOf('word '.repeat(80))
    expect(s.length).toBeLessThanOrEqual(200)
    expect(s.endsWith('…')).toBe(true)
  })
})
