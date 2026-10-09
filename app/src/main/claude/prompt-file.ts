import { createHash } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import os from 'os'
import { join } from 'path'

/**
 * Hand the CLI its appended system prompt as a file instead of an argument.
 *
 * An argument is part of the process's command line, and the prompt is pages of
 * prose naming every tool an agent might use: `xcodebuild`, `simctl`, `open`.
 * So one chat tidying up after itself with `pkill -f xcodebuild` matched the
 * command line of every OTHER chat's `claude` (pkill spares only its own
 * ancestors) and killed them all, mid-reply, a second later. Nothing of the
 * prompt may sit where a pattern match on process names can find it.
 *
 * Named by its content, so chats with the same prompt share one file and
 * nothing needs cleaning up after a session; rewritten on every start, so a
 * temp directory swept by the system costs nothing.
 */
export function promptAsFile(
  args: string[],
  dir = join(os.tmpdir(), 'superagent-prompts')
): string[] {
  const at = args.indexOf('--append-system-prompt')
  if (at < 0 || at + 1 >= args.length) return args
  const prompt = args[at + 1]
  const file = join(dir, `${createHash('sha1').update(prompt).digest('hex').slice(0, 16)}.md`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, prompt, { mode: 0o600 })
  } catch {
    // Nowhere to write it: the prompt on the command line beats no prompt.
    return args
  }
  return [...args.slice(0, at), '--append-system-prompt-file', file, ...args.slice(at + 2)]
}
