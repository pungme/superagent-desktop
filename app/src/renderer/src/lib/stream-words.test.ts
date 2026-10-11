import { describe, it, expect } from 'vitest'
import { nextReveal, rehypeStreamWords } from './stream-words'

describe('the pace a reply is shown at', () => {
  const text = 'The quick brown fox jumps over the lazy dog, twice over. '.repeat(40)

  it('moves on at a steady pace, and ends on the end of a word', () => {
    const n = nextReveal(0, 'hello there, world', 16)
    expect(n).toBeGreaterThan(0)
    expect('hello there, world'.slice(0, n)).toMatch(/^(hello|hello there,|hello there, world)$/)
  })

  it('quickens when it has fallen behind, and never lags far', () => {
    const little = nextReveal(0, text.slice(0, 40), 16)
    const much = nextReveal(0, text.slice(0, 600), 16) - 0
    expect(much).toBeGreaterThan(little)
    // A burst far longer than the limit is not replayed from its start.
    expect(nextReveal(0, text, 16)).toBeGreaterThan(text.length - 900)
  })

  it('gets there, and stays there', () => {
    let shown = 0
    let frames = 0
    while (shown < 500 && frames < 600) {
      shown = nextReveal(shown, text.slice(0, 500), 16)
      frames++
    }
    expect(shown).toBe(500)
    // About a second for 500 characters that arrived at once: quick, not instant.
    expect(frames).toBeGreaterThan(8)
    expect(frames).toBeLessThan(120)
    expect(nextReveal(500, text.slice(0, 500), 16)).toBe(500)
    // A reply that got shorter (it never does) does not run past its end.
    expect(nextReveal(500, 'short', 16)).toBe(5)
  })
})

describe('each word of a reply in a span of its own', () => {
  const el = (tagName: string, children: unknown[]): unknown => ({
    type: 'element',
    tagName,
    properties: {},
    children
  })
  const t = (value: string): unknown => ({ type: 'text', value })
  const words = (node: unknown): string[] => {
    const out: string[] = []
    const walk = (n: { tagName?: string; properties?: { className?: string[] }; children?: unknown[] }): void => {
      if (n.tagName === 'span' && n.properties?.className?.includes('sw'))
        out.push((n.children as { value: string }[])[0].value)
      else for (const c of n.children ?? []) walk(c as never)
    }
    walk(node as never)
    return out
  }

  it('wraps prose, through emphasis and links, keeping the spaces', () => {
    const tree = {
      type: 'root',
      children: [el('p', [t('Two lines, '), el('strong', [t('not three')]), t('. Done.')])]
    }
    rehypeStreamWords()(tree)
    expect(words(tree)).toEqual(['Two', 'lines,', 'not', 'three', '.', 'Done.'])
    const p = (tree.children[0] as { children: { type: string; value?: string }[] }).children
    expect(p.filter((c) => c.type === 'text').map((c) => c.value)).toEqual([' ', ' ', ' '])
  })

  it('leaves code exactly as it was', () => {
    const code = el('pre', [el('code', [t('const a = 1\n  return a')])])
    const tree = { type: 'root', children: [el('p', [t('Run '), el('code', [t('npm test')])]), code] }
    rehypeStreamWords()(tree)
    expect(words(tree)).toEqual(['Run'])
    expect(JSON.stringify(tree)).toContain('const a = 1\\n  return a')
    expect(JSON.stringify(tree)).toContain('npm test')
  })
})
