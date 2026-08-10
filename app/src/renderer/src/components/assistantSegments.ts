export interface ChoiceSpec {
  question?: string
  multiple?: boolean
  options: { label: string; hint?: string }[]
}

const ASK_RE = /```ask\s*\n([\s\S]*?)```/g

/** One segment of an assistant message: prose (markdown) or a choices block. */
export type AssistantSegment = { md: string } | { ask: ChoiceSpec }

/**
 * Split an assistant message into markdown runs and ```ask choice blocks. A
 * malformed block is left as prose; an unclosed one (still streaming) is hidden
 * until its closing fence arrives, so the raw JSON never flashes on screen.
 */
export function splitAssistant(text: string): AssistantSegment[] {
  const out: AssistantSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  ASK_RE.lastIndex = 0
  while ((m = ASK_RE.exec(text))) {
    let spec: ChoiceSpec | null = null
    try {
      const o = JSON.parse(m[1].trim())
      if (o && Array.isArray(o.options) && o.options.length) spec = o as ChoiceSpec
    } catch {
      spec = null
    }
    if (!spec) continue // leave malformed blocks in the surrounding prose
    if (m.index > last) out.push({ md: text.slice(last, m.index) })
    out.push({ ask: spec })
    last = ASK_RE.lastIndex
  }
  let tail = text.slice(last)
  const open = tail.indexOf('```ask')
  if (open >= 0 && tail.indexOf('```', open + 6) < 0) tail = tail.slice(0, open)
  if (tail.trim()) out.push({ md: tail })
  return out
}

/**
 * Clickable options Claude offered via an ```ask block. Single-select sends the
 * pick immediately; multi-select collects checks and sends on "Send". The answer
 * goes back as the user's next message (which reaches Claude right away).
 */
