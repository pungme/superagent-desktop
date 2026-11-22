/**
 * Antigravity's quotas are per model: "Gemini 4 Neon" can be out for days while
 * its Claude and GPT-OSS models, on the same account, have plenty. So a quota
 * message moves the chat to another model first, and only when none is left does
 * it count as the account being out (main/accounts.ts).
 *
 * A model is listed once per effort ("gemini-4-neon-high", "-low"): they share
 * one quota, so they are one group here. Pure: no Electron, no Node.
 */
const EFFORT = /-(minimal|low|medium|high|xhigh|max)$/i

/** "gemini-4-neon-high" → "gemini-4-neon". */
export function agyGroup(id: string): string {
  return id.replace(EFFORT, '')
}

function effortOf(id: string): string {
  return EFFORT.exec(id)?.[1]?.toLowerCase() ?? ''
}

/**
 * The model to move to when `current`'s group is out: the first in the
 * line-up whose group is neither that one nor out itself, at the same effort
 * where that group has it. Null when every other group is out too.
 */
export function agyFallback(
  current: string,
  lineUp: string[],
  isOut: (group: string) => boolean
): string | null {
  const from = agyGroup(current)
  const effort = effortOf(current)
  const groups: string[] = []
  for (const id of lineUp) {
    const g = agyGroup(id)
    if (g !== from && !isOut(g) && !groups.includes(g)) groups.push(g)
  }
  if (!groups.length) return null
  const g = groups[0]
  const inGroup = lineUp.filter((id) => agyGroup(id) === g)
  return inGroup.find((id) => effortOf(id) === effort) ?? inGroup[0]
}

/**
 * The model a chat starts on: what it picked, unless that group is out, then
 * the fallback. `picked` undefined is Default; `defaultModel` is what Default
 * turned out to be last time it was seen.
 */
export function agyRunModel(
  picked: string | undefined,
  defaultModel: string | undefined,
  lineUp: string[],
  isOut: (group: string) => boolean
): string | undefined {
  const actual = picked ?? defaultModel
  if (!actual || !isOut(agyGroup(actual))) return picked
  return agyFallback(actual, lineUp, isOut) ?? picked
}
