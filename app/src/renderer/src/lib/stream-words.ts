/**
 * A reply that arrives, drawn so it reads as arriving.
 *
 * Two parts, the way the better chat apps do it (Vercel's Streamdown,
 * FlowToken, LibreChat's smooth streaming):
 *
 *  1. Pacing. An agent's words come in bursts: nothing, then forty characters
 *     at once. Shown as they come, the text jerks. `nextReveal` lets what is on
 *     screen follow what has arrived at an even pace that quickens when it
 *     falls behind, so it never lags far and never jumps.
 *  2. Each word comes in. `rehypeStreamWords` wraps every word of the reply in
 *     a span; React keeps the spans it already drew, so only a NEW word runs
 *     the CSS animation (.sw in main.css: out of a blur, into focus).
 *
 * Both are only for the reply being written. A settled message is plain text,
 * with no spans left behind.
 */

/** Slowest the text moves, in characters a second: a comfortable reading-along pace. */
const MIN_RATE = 70
/** How much of what is still waiting is shown each second on top of that. */
const CATCH_UP = 5
/** Never further behind than this many characters: a long burst is not replayed slowly. */
const MAX_BEHIND = 900

/**
 * How many characters of `target` to show now, having shown `shown`, `dtMs`
 * after the last step. Ends on the end of a word, so a word is never seen
 * half-written and then finished.
 */
export function nextReveal(shown: number, target: string, dtMs: number): number {
  const total = target.length
  if (shown >= total) return total
  const from = Math.max(shown, total - MAX_BEHIND)
  const behind = total - from
  const step = Math.max(1, Math.round(((MIN_RATE + behind * CATCH_UP) * Math.max(0, dtMs)) / 1000))
  let n = Math.min(total, from + step)
  // On to the end of the word it landed in, within reason.
  let look = 0
  while (n < total && look < 24 && !/\s/.test(target[n])) {
    n++
    look++
  }
  return n
}

interface HNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HNode[]
}

/** Text in these is left alone: code keeps its spacing, and the rest is not prose. */
const SKIP = new Set(['code', 'pre', 'svg', 'math', 'annotation', 'script', 'style'])

function wrap(node: HNode): void {
  if (!node.children) return
  const out: HNode[] = []
  for (const child of node.children) {
    if (child.type === 'element') {
      if (!SKIP.has(child.tagName ?? '')) wrap(child)
      out.push(child)
      continue
    }
    if (child.type !== 'text' || !child.value || !child.value.trim()) {
      out.push(child)
      continue
    }
    // Words and the spaces between them, the spaces left as they are.
    for (const part of child.value.split(/(\s+)/)) {
      if (!part) continue
      if (/^\s+$/.test(part)) out.push({ type: 'text', value: part })
      else
        out.push({
          type: 'element',
          tagName: 'span',
          properties: { className: ['sw'] },
          children: [{ type: 'text', value: part }]
        })
    }
  }
  node.children = out
}

/** A rehype plugin: every word of the prose in a span of its own (class "sw"). */
export function rehypeStreamWords() {
  return (tree: unknown): void => wrap(tree as HNode)
}
