/**
 * Reading a backgrounded command for what the runs strip needs to know.
 *
 * Pure and separate from the chat so it can be tested without standing up the
 * store — the same reason ports.ts and omnibox.ts live here.
 */

/**
 * Where a backgrounded command sends its output, if it redirects.
 *
 * `foo > /tmp/x.log 2>&1 &` is how an agent usually backgrounds something that
 * prints — Codex reaches for it by default. Reading the path back out of the
 * command is what turns "no handle to read its output" into a live tail, and it
 * works whichever agent wrote the command.
 *
 * Absolute paths only: a relative one is relative to the agent's working
 * directory, which is not necessarily what the tail would resolve against.
 */
export function redirectTarget(command: string): string | undefined {
  // `2>&1` duplicates a descriptor and `/dev/null` discards — neither is a file
  // worth tailing, so both fall out of the match rather than being special-cased.
  const m = command.match(/(?:^|\s)\d?>>?\s*("([^"]+)"|'([^']+)'|([^\s&|;<>]+))/)
  const path = m?.[2] ?? m?.[3] ?? m?.[4]
  if (!path || !path.startsWith('/') || path.startsWith('/dev/')) return undefined
  return path
}
