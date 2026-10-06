/** One request's (or one turn's) usage, as the agent CLIs report it. */
export interface TokenUsage {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens?: number
}

/**
 * What a request added: what the agent wrote, plus what went into the
 * conversation for the first time (uncached input and cache writes).
 *
 * This is the figure worth showing as "tokens used". Every request also
 * re-reads the whole conversation so far from cache, and a turn makes one
 * request per tool call — so adding the cache reads in, as the chat's total
 * used to, counted a 300k conversation fifty times over for one busy turn and
 * showed 19M for a chat that had written 87k.
 */
export function newTokens(u: TokenUsage): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
}

/** Everything a request carried, cache reads included. */
export function processedTokens(u: TokenUsage): number {
  return newTokens(u) + (u.cache_read_input_tokens ?? 0)
}
