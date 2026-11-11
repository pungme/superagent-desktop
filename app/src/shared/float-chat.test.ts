import { describe, it, expect } from 'vitest'
import { floatBounds, floatStatus, plainText } from './float-chat'

describe('the floating chat', () => {
  it('sits in the bottom-right corner of the page, never larger than it', () => {
    expect(floatBounds({ x: 300, y: 50, w: 1000, h: 700 }, { w: 96, h: 108 })).toEqual({
      x: 300 + 1000 - 96 - 18,
      y: 50 + 700 - 108 - 18,
      width: 96,
      height: 108
    })
    const huge = floatBounds({ x: 0, y: 0, w: 500, h: 400 }, { w: 440, h: 4000 })
    expect(huge.height).toBe(400 - 18)
    expect(huge.y).toBe(0)
  })
  it('says in one line what the agent is doing', () => {
    expect(floatStatus('Editing', '/Users/me/site/src/index.html')).toBe('Editing index.html')
    expect(floatStatus('Terminal', 'npm test -- --run\nmore')).toBe('Terminal npm test -- --run')
    expect(floatStatus('Reading', '')).toBe('Reading')
    expect(floatStatus('Terminal', 'U=90A321FB-4D64 CI=1 xcrun simctl boot')).toBe(
      'Terminal xcrun simctl boot'
    )
    expect(floatStatus('Terminal', 'x'.repeat(100)).length).toBe(48)
  })
  it('shows a message as plain words', () => {
    expect(plainText('Done. The **card** now uses `blue`, see [the page](http://x).')).toBe(
      'Done. The card now uses blue, see the page.'
    )
    expect(plainText('```js\nconst a = 1\n```\nthen')).toBe('[code] then')
  })
})
