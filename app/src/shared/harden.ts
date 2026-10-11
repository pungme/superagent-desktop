/**
 * What the released app refuses to be started with.
 *
 * An agent has a shell in the user's account, and could start a second copy
 * of Superagent itself: one with its settings in a folder the agent wrote
 * (computer use switched on, every app allowed), or with a debugging port
 * open to drive it from. To macOS that copy is Superagent, with Superagent's
 * permissions to see the screen and post events. So the released app takes
 * none of the switches that tests and development use.
 */

/** Command-line switches that hand the app, or where it keeps its data, to whoever started it. */
const SWITCHES =
  /^--(remote-debugging-port|remote-debugging-pipe|remote-debugging-address|inspect|inspect-brk|inspect-port|inspect-publish-uid|user-data-dir|js-flags|load-extension|disable-web-security|no-sandbox)(=|$)/

/** The switch in `argv` the released app must not run with, or null. */
export function forbiddenSwitch(argv: readonly string[]): string | null {
  return argv.slice(1).find((a) => SWITCHES.test(a)) ?? null
}

/** The environment variables that are for tests and development only. */
export function testOnlyEnv(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter(
    (k) => k === 'COVE_USER_DATA' || k === 'COVE_REMOTE_DEBUG' || k.startsWith('COVE_E2E_')
  )
}
