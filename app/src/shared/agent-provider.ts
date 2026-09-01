/**
 * Which coding agent is behind a chat.
 *
 * Superagent ships no AI of its own — it drives a CLI the user already pays for.
 * Claude Code was the first; Codex is the second. A provider is picked per chat
 * (with a global default) because a conversation's transcript belongs to one
 * backend's session: the id in `chats.claudeSessionId` is a Claude session id or
 * a Codex thread id depending on this field, and neither can resume the other's.
 */

export type AgentProvider = 'claude' | 'codex'

export const AGENT_PROVIDERS: AgentProvider[] = ['claude', 'codex']

export const DEFAULT_PROVIDER: AgentProvider = 'claude'

/** What to call each one in the UI, and to the agent itself in a recap. */
export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

/** The full product name, for onboarding and settings. */
export const PROVIDER_PRODUCT: Record<AgentProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

/** The binary each provider is driven through. */
export const PROVIDER_BINARY: Record<AgentProvider, string> = {
  claude: 'claude',
  codex: 'codex'
}

/**
 * The model names Claude Code answers to. Anything else belongs to Codex.
 *
 * A model is only meaningful to the agent that offers it: `opus` means nothing
 * to Codex, and `gpt-5-codex` means nothing to Claude Code. Passing one to the
 * other is not a bad setting, it is a CLI that refuses to start — which is how
 * a conversation on the wrong agent goes silent.
 */
const CLAUDE_MODELS = /^(default|opus|sonnet|haiku)(\[[^\]]+\])?$/i

export function modelBelongsTo(model: string | undefined, provider: AgentProvider): boolean {
  if (!model) return true
  return CLAUDE_MODELS.test(model.trim()) === (provider === 'claude')
}

/**
 * Claude Code's permission modes. Codex has its own idea of sandboxing and does
 * not take these, so passing one along is the same mistake as the model.
 */
const CLAUDE_MODES = new Set(['bypassPermissions', 'acceptEdits', 'plan', 'ask'])

export function modeBelongsTo(mode: string | undefined, provider: AgentProvider): boolean {
  if (!mode) return true
  return CLAUDE_MODES.has(mode) === (provider === 'claude')
}

/** Narrow an unknown (IPC payload, localStorage string, sqlite column) to a provider. */
export function toProvider(value: unknown): AgentProvider {
  return value === 'codex' ? 'codex' : 'claude'
}
