/**
 * Prompt links: `superagent://prompt?text=…&project=…` opens Superagent with a
 * new conversation whose message box already holds the text. A link never
 * sends anything and never changes a setting: you read the prompt, then press
 * Send, and your own model, mode and branch apply. For sharing a prompt on
 * social media, or a one-click fix in a pull request comment.
 *
 * Pure (no Electron), so the parsing is tested on its own.
 */
export const PROMPT_LINK_SCHEME = 'superagent'
export const MAX_PROMPT = 8000

export interface PromptLink {
  text: string
  /** A project name or a repository ("owner/repo"); none: a chat of its own. */
  project?: string
}

/** The link's prompt, or null for anything that is not a prompt link. */
export function parsePromptLink(raw: string): PromptLink | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== `${PROMPT_LINK_SCHEME}:`) return null
  // superagent://prompt?… parses with "prompt" as the host; superagent:prompt?… as the path.
  const what = (u.host || u.pathname).replace(/^\/+|\/+$/g, '')
  if (what !== 'prompt') return null
  const text = clean(u.searchParams.get('text') ?? '').slice(0, MAX_PROMPT)
  if (!text.trim()) return null
  const project = clean(u.searchParams.get('project') ?? u.searchParams.get('repo') ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return project ? { text, project } : { text }
}

/** A link that opens this prompt, in this project when one is given. */
export function promptLink(text: string, project?: string): string {
  const q = new URLSearchParams({ text: text.slice(0, MAX_PROMPT) })
  if (project) q.set('project', project)
  return `${PROMPT_LINK_SCHEME}://prompt?${q.toString()}`
}

/** No control characters (bidi and zero-width included) beyond line breaks and tabs. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
}
