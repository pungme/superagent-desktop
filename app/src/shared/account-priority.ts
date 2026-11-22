import { AGENT_PROVIDERS, type AgentProvider } from './agent-provider'

/**
 * One priority list across every agent's accounts: "Claude · Personal, then
 * Codex · Plus, then Claude · Work". Without one of the user's own, the order is
 * each agent's accounts in its own order, Claude then Codex then Antigravity.
 * Pure, so the rules are tested without the accounts file.
 */
export interface Ranked {
  id: string
  provider: AgentProvider
}

/** Every account in priority order: the chosen order first, the rest after in agent order. */
export function rankAccounts<T extends Ranked>(
  perAgent: Record<AgentProvider, T[]>,
  chosen: string[] | undefined
): T[] {
  const byAgent = AGENT_PROVIDERS.flatMap((p) => perAgent[p] ?? [])
  if (!chosen?.length) return byAgent
  const byId = new Map(byAgent.map((a) => [a.id, a]))
  const out: T[] = []
  for (const id of chosen) {
    const a = byId.get(id)
    if (a) {
      out.push(a)
      byId.delete(id)
    }
  }
  return [...out, ...byId.values()]
}

/**
 * The account a chat moves to when `exhausted` runs out: the first in priority
 * order that can take it, whichever agent it belongs to. Null when none can.
 */
export function nextInPriority<T extends Ranked>(
  ranked: T[],
  exhausted: string,
  usable: (a: T) => boolean
): T | null {
  return ranked.find((a) => a.id !== exhausted && usable(a)) ?? null
}

/** Each agent's own order, as the cross-agent order puts it. */
export function perAgentOrder(ranked: Ranked[], provider: AgentProvider): string[] {
  return ranked.filter((a) => a.provider === provider).map((a) => a.id)
}
