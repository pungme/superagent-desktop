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

/** Narrow an unknown (IPC payload, localStorage string, sqlite column) to a provider. */
export function toProvider(value: unknown): AgentProvider {
  return value === 'codex' ? 'codex' : 'claude'
}
