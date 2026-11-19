/**
 * Who an agent CLI is signed in as, read from what the CLI itself keeps, for the
 * account rows in Settings: "pung@example.com · Plus plan".
 */

/** A JWT's middle part, or null. */
function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const plan = (p: unknown): string =>
  typeof p === 'string' && p && p !== 'free'
    ? `${p[0].toUpperCase()}${p.slice(1)} plan`
    : typeof p === 'string' && p === 'free'
      ? 'Free plan'
      : ''

/**
 * Codex's auth.json: a ChatGPT sign-in carries an id_token naming the email and
 * the plan. An API key carries neither. '' when there is nothing to say.
 */
export function codexWho(authJson: string): string {
  try {
    const j = JSON.parse(authJson) as {
      OPENAI_API_KEY?: string | null
      tokens?: { id_token?: string } | null
    }
    const idToken = j.tokens?.id_token
    if (!idToken) return j.OPENAI_API_KEY ? 'API key' : ''
    const c = jwtClaims(idToken)
    if (!c) return ''
    const auth = c['https://api.openai.com/auth'] as { chatgpt_plan_type?: string } | undefined
    const email = typeof c.email === 'string' ? c.email : ''
    return [email, plan(auth?.chatgpt_plan_type)].filter(Boolean).join(' · ')
  } catch {
    return ''
  }
}

/**
 * Antigravity has no "who am I" command, but every run logs the account it
 * signed in with: `applyAuthResult: email=pung@example.com, authMethod=…`.
 * The last such line in its log. '' when there is none.
 */
export function antigravityWho(log: string): string {
  const all = [...log.matchAll(/applyAuthResult: email=([^\s,]+@[^\s,]+)/g)]
  return all.length ? all[all.length - 1][1] : ''
}
