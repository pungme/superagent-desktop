/**
 * An agent's reply that answers one message in particular.
 *
 * The agent is told (prompts.ts) to open such a reply by quoting the message
 * it answers, as a Markdown blockquote on the first line. A plain client shows
 * that as a quote, which already reads right; Superagent lifts it out and
 * draws it the way a messaging app draws a reply — the message quoted in a
 * chip above the answer.
 *
 * Only when the quote really is something the user said: an agent also opens
 * with a blockquote to cite a log line or a doc, and that is not a reply.
 */

const tidy = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’*_\s]+|["'“”‘’*_\s]+$/g, '')
    .replace(/(…|\.{3})$/, '')
    .trim()

/** The blockquote a text opens with, and what follows it. Null if it opens with none. */
export function splitLeadingQuote(text: string): { quote: string; rest: string } | null {
  const lines = text.replace(/^\s*\n/, '').split('\n')
  let i = 0
  const quoted: string[] = []
  while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
    quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''))
    i++
  }
  if (!quoted.length) return null
  const quote = tidy(quoted.join(' '))
  const rest = lines
    .slice(i)
    .join('\n')
    .replace(/^\s*\n/, '')
  if (!quote || !rest.trim()) return null
  return { quote, rest }
}

/**
 * The user's message a reply opens by quoting, with the reply's own text —
 * or null when it does not open with one of the user's messages.
 * `userTexts` is what the user has said, oldest first.
 */
export function replyingTo(
  text: string,
  userTexts: readonly string[]
): { quote: string; rest: string } | null {
  const lead = splitLeadingQuote(text)
  if (!lead || lead.quote.length < 2) return null
  const needle = lead.quote.toLowerCase()
  return userTexts.some((t) => tidy(t).toLowerCase().includes(needle)) ? lead : null
}
