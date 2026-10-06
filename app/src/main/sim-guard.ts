import { getChat } from './store'
import { chatHoldingSimulator, simulatorsByChat } from './simulator'

/**
 * Keeps a conversation's shell off another conversation's simulator.
 *
 * The sim_* tools give each conversation its own device, but an agent builds
 * and installs from the shell at least as often: `xcodebuild test -destination
 * 'name=iPhone 17e'`, `xcrun simctl install booted …`. Neither goes through
 * those tools, and both land on whichever device answers to the name or
 * happens to be booted, which is how one conversation's build replaced the
 * app another was testing. Asked of every shell command before it runs.
 *
 * Returns why the command should not run as written, or null. Not a refusal:
 * the agent is told which device is its own and runs it again.
 */

const UDID = /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/gi
/** simctl verbs that only look. */
const READS = /^(list|help|runtime|getenv|get_app_container|listapps|appinfo|diagnose|logverbose)$/

export interface SimHolders {
  /** The device this conversation drives, if it has one. */
  mine: string | null
  /** The title of the other conversation on a device, or null when it is free. */
  takenBy: (udid: string) => string | null
}

export function simShellVerdict(command: string, who: SimHolders): string | null {
  const simctl = /\bsimctl\b/.test(command)
  const xcodebuild = /\bxcodebuild\b/.test(command) && /-destination\b/.test(command)
  if (!simctl && !xcodebuild) return null

  const own = who.mine
    ? `This conversation's simulator is ${who.mine}; use that UDID.`
    : 'Call sim_list_devices first: it gives this conversation a simulator of its own and marks it YOURS. Then use that UDID.'

  for (const udid of command.match(UDID) ?? []) {
    if (who.mine && udid.toUpperCase() === who.mine.toUpperCase()) continue
    const other = who.takenBy(udid.toUpperCase()) ?? who.takenBy(udid)
    if (other)
      return `Not run: the simulator ${udid} is in use by "${other}", and this would change what that conversation is running. ${own}`
  }

  if (simctl) {
    // Every `simctl <verb> … booted` in the command, except the ones that only look.
    for (const m of command.matchAll(/\bsimctl\s+([a-z_]+)\b([^\n;|&]*)/g)) {
      if (READS.test(m[1]) || !/(^|\s)booted(\s|$)/.test(m[2])) continue
      return `Not run: \`booted\` is whichever simulator happens to be running, which may be another conversation's. ${own}`
    }
  }

  if (xcodebuild) {
    for (const m of command.matchAll(/-destination\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
      const dest = m[1] ?? m[2] ?? m[3] ?? ''
      // "generic/platform=…" only builds; nothing is installed anywhere.
      if (/generic\//.test(dest) || /\bid=/.test(dest) || !/simulator/i.test(dest)) continue
      if (/\bname=/.test(dest))
        return `Not run: a destination by name (${dest}) goes to whichever simulator has that name, which may be another conversation's. Use -destination "platform=iOS Simulator,id=<UDID>". ${own}`
    }
  }
  return null
}

/** Called before a shell tool runs; null lets it through. */
export function simulatorBeforeShell(
  toolName: string,
  input: unknown,
  chatId: string | null | undefined
): string | null {
  if (toolName !== 'Bash' || !chatId) return null
  const command = (input as { command?: unknown } | null)?.command
  if (typeof command !== 'string' || !command) return null
  return simShellVerdict(command, {
    mine: simulatorsByChat().get(chatId) ?? null,
    takenBy: (udid) => {
      const holder = chatHoldingSimulator(udid, chatId)
      return holder ? getChat(holder)?.title || 'another conversation' : null
    }
  })
}
