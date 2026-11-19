import { AGENT_PROVIDERS, type AgentProvider } from './agent-provider'

/**
 * When every account of the agent a chat runs on is out of allowance, the chat can
 * carry on with another agent: Claude to Codex to Antigravity and round again, the
 * first one after the current that is signed in and has allowance. Pure, so the
 * order and the rules are tested without the accounts file.
 */
export function agentsToTry(
  current: AgentProvider,
  available: (p: AgentProvider) => boolean
): AgentProvider[] {
  const i = AGENT_PROVIDERS.indexOf(current)
  const rotated = [...AGENT_PROVIDERS.slice(i + 1), ...AGENT_PROVIDERS.slice(0, i)]
  return rotated.filter((p) => p !== current && available(p))
}
