/**
 * What a chat falls back to when its model's allowance runs out (or the model
 * is overloaded, retired, blocked): the next one down on the same account,
 * which costs nothing to move to — no second subscription, no re-read of the
 * conversation. Only when the whole account is out does the chat change
 * accounts (main/accounts.ts).
 *
 * The CLI does the falling back itself, per turn, and tries the first choice
 * again on the next one — so the chat is back on Fable as soon as it can be.
 *
 * Shared between main and renderer, so no Electron or Node imports.
 */

/** The `--fallback-model` for a chat's model; null where there is nothing sensible below it. */
export function fallbackModelFor(model: string | null | undefined): string | null {
  const m = (model ?? '').toLowerCase()
  // Default: the CLI picks (Fable, where the account has it), Opus behind it.
  if (!m || m === 'default') return 'opus'
  if (m.includes('opus')) return 'sonnet'
  // Below Sonnet the step down is too far to take without being asked.
  if (m.includes('sonnet') || m.includes('haiku')) return null
  return 'opus'
}

/** "claude-fable-5-1[1m]" → "fable"; null for Default or a model that is not Claude's. */
export function modelFamily(id: string | null | undefined): string | null {
  return /(fable|mythos|opus|sonnet|haiku)/i.exec(id ?? '')?.[1].toLowerCase() ?? null
}

/** "claude-fable-5-1[1m]" → "Fable 5.1", "opus" → "Opus". */
export function prettyModel(id: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?(?!\d))?/i.exec(id)
  if (!m) return id
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  if (!m[2]) return family
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** The CLI's `system`/`model_fallback` event, if this is one. */
export function modelFallbackFrom(
  event: Record<string, unknown>
): { original: string; fallback: string; trigger: string } | null {
  if (event.type !== 'system' || event.subtype !== 'model_fallback') return null
  const original = typeof event.original_model === 'string' ? event.original_model : ''
  const fallback = typeof event.fallback_model === 'string' ? event.fallback_model : ''
  if (!fallback) return null
  return { original, fallback, trigger: typeof event.trigger === 'string' ? event.trigger : '' }
}

/** One line for the chat: what happened and what it is running on now. */
export function fallbackNotice(f: { original: string; fallback: string; trigger: string }): string {
  const from = f.original ? prettyModel(f.original) : 'The model'
  const to = prettyModel(f.fallback)
  const why =
    f.trigger === 'usage_limit'
      ? 'has used up its allowance for now'
      : f.trigger === 'overloaded' || f.trigger === 'server_error'
        ? 'is overloaded right now'
        : f.trigger === 'model_not_found' || f.trigger === 'model_blocked'
          ? "isn't available"
          : f.trigger === 'permission_denied'
            ? "isn't on this account"
            : "isn't available right now (its allowance may be used up)"
  return `↻ ${from} ${why} — continuing on ${to}. It goes back to ${from} as soon as it can.`
}
