import { getChat } from './store'
import {
  chatHoldingSimulator,
  knownDeviceNames,
  noteSimulatorUsed,
  simulatorsByChat
} from './simulator'

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
  /** Device names as simctl knows them (lower-cased) → UDID. simctl takes names too. */
  names?: ReadonlyMap<string, string>
}

export function simShellVerdict(command: string, who: SimHolders): string | null {
  const simctl = /\bsimctl\b/.test(command)
  const xcodebuild = /\bxcodebuild\b/.test(command) && /-destination\b/.test(command)

  const own = who.mine
    ? `This conversation's simulator is ${who.mine}; use that UDID.`
    : 'Call sim_list_devices first: it gives this conversation a simulator of its own and marks it YOURS. Then use that UDID.'

  // Looking at another conversation's simulator changes nothing for it.
  const onlyLooks =
    !xcodebuild &&
    [...command.matchAll(/\bsimctl\s+([a-z_]+)\b([^\n;|&]*)/g)].every(
      (m) => READS.test(m[1]) || (m[1] === 'io' && /\b(screenshot|enumerate)\b/.test(m[2]))
    )
  // Any command naming another conversation's device, not only simctl and
  // xcodebuild: a helper script (`./ios-run.sh <UDID>`) calls them out of sight,
  // and that is how one conversation kept installing over another's.
  for (const udid of onlyLooks && simctl ? [] : (command.match(UDID) ?? [])) {
    if (who.mine && udid.toUpperCase() === who.mine.toUpperCase()) continue
    const other = who.takenBy(udid.toUpperCase()) ?? who.takenBy(udid)
    if (other)
      return `Not run: the simulator ${udid} is in use by "${other}", and this would change what that conversation is running. ${own}`
  }

  // Commands that reach every device without naming one, so no UDID in the
  // text gives them away: `simctl shutdown all`, a list piped into xargs, a
  // loop over `simctl list`, killing the simulator service. How a conversation
  // clearing its own clutter took another one's device with it.
  for (const m of command.matchAll(/\bsimctl\s+(shutdown|erase|delete)\s+all\b/g))
    return `Not run: \`simctl ${m[1]} all\` reaches every conversation's simulator, not only this one's. ${own}`
  if (
    simctl &&
    (/\bxargs\b[^\n;]*\bsimctl\b/.test(command) ||
      (/\bsimctl\s+list\b/.test(command) &&
        /\b(for|while)\b|\|\s*xargs\b/.test(command) &&
        /\bsimctl\s+(shutdown|erase|delete|install|uninstall|launch|terminate|boot|openurl|push|addmedia|spawn|privacy|keychain|pbcopy)\b/.test(
          command
        )))
  )
    return `Not run: a list of simulators fed into simctl would act on other conversations' devices too. Name this conversation's UDID in the command. ${own}`
  if (/\b(killall|pkill)\b[^\n;|&]*\b(CoreSimulator|SimulatorTrampoline|Simulator)\b/.test(command))
    return `Not run: stopping Simulator or CoreSimulator stops every conversation's device. ${own}`

  if (!simctl && !xcodebuild) return null

  if (simctl) {
    // Every `simctl <verb> … booted` in the command, except the ones that only look.
    for (const m of command.matchAll(/\bsimctl\s+([a-z_]+)\b([^\n;|&]*)/g)) {
      if (READS.test(m[1]) || !/(^|\s)booted(\s|$)/.test(m[2])) continue
      return `Not run: \`booted\` is whichever simulator happens to be running, which may be another conversation's. ${own}`
    }
    // simctl takes a device NAME where it takes a UDID, and "iPhone 17" is as
    // likely another conversation's "iPhone 17" as this one's "iPhone 17 (2)".
    // Longest names first, so "iPhone 17 (2)" is not taken for "iPhone 17".
    const names = [...(who.names ?? [])].sort((a, b) => b[0].length - a[0].length)
    if (names.length) {
      for (const m of command.matchAll(/\bsimctl\s+([a-z_]+)\b([^\n;|&]*)/g)) {
        if (READS.test(m[1])) continue
        const args = m[2].toLowerCase()
        const hit = names.find(([n]) =>
          new RegExp(`(^|[\\s"'=])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s"'])`).test(
            args
          )
        )
        if (!hit) continue
        const [name, udid] = hit
        if (who.mine && udid.toUpperCase() === who.mine.toUpperCase()) continue
        const other = who.takenBy(udid.toUpperCase()) ?? who.takenBy(udid)
        return other
          ? `Not run: "${name}" is the simulator of "${other}", and this would change what that conversation is running. ${own}`
          : `Not run: a simulator by name ("${name}") may be another conversation's; simctl takes the UDID in its place. ${own}`
      }
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
  const verdict = simShellVerdict(command, {
    mine: simulatorsByChat().get(chatId) ?? null,
    names: knownDeviceNames(),
    takenBy: (udid) => {
      const holder = chatHoldingSimulator(udid, chatId)
      return holder ? getChat(holder)?.title || 'another conversation' : null
    }
  })
  // Let through: whatever free device it names is this conversation's now.
  if (!verdict) for (const udid of command.match(UDID) ?? []) noteSimulatorUsed(chatId, udid)
  return verdict
}
