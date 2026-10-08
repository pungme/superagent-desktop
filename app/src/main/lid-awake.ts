import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import os from 'os'
import { kvGet, kvSet } from './store'

/**
 * Keep working with the lid closed. Off unless the user turns it on.
 *
 * macOS sleeps a closed MacBook whatever an app asks: the power assertion
 * Superagent already holds covers idle sleep, not the lid. The one switch that
 * does is system-wide and root's: `pmset -a disablesleep 1`. So turning this on
 * asks for an administrator password once, to install a rule that lets this
 * user run exactly that command (and its opposite, and the rule's own removal)
 * without being asked again. From then on the switch follows the app: set
 * while Superagent is open, cleared when it quits, and cleared at the next
 * launch if it was left set by a crash. Turning it off removes the rule.
 *
 * It is system-wide while it is on: a closed Mac in a bag keeps running, warm,
 * on battery. The setting says so.
 */

const KEY = 'power.lidAwake'
export const RULE_PATH = '/etc/sudoers.d/superagent-lid-awake'
const PMSET = '/usr/bin/pmset'

/** A login name that is safe to write into a sudoers file, or null. */
export function safeUser(name: string): string | null {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : null
}

/** The rule: this user, these three commands, nothing wider. */
export function sudoersRule(user: string): string {
  return (
    `# Installed by Superagent (Settings → General → Keep working with the lid closed).\n` +
    `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1, /bin/rm -f ${RULE_PATH}\n`
  )
}

/** The shell an administrator runs once: check the rule parses, then install it. */
export function installScript(user: string): string {
  const tmp = `/tmp/superagent-lid-awake.$$`
  return [
    `printf '%s' ${quote(sudoersRule(user))} > ${tmp}`,
    `/usr/sbin/visudo -cf ${tmp}`,
    `/usr/bin/install -m 0440 -o root -g wheel ${tmp} ${RULE_PATH}`,
    `/bin/rm -f ${tmp}`
  ].join(' && ')
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function run(cmd: string, args: string[], timeout = 15_000): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout }, (error, _out, stderr) =>
      resolve({ ok: !error, err: String(stderr || error?.message || '').trim() })
    )
  )
}

/** Never against the real system from a test run. */
const inert = (): boolean => !!process.env.COVE_USER_DATA || process.platform !== 'darwin'

export function lidAwakeEnabled(): boolean {
  return kvGet(KEY) === '1'
}

/** Set or clear the system switch through the installed rule. False if it is not allowed. */
async function setDisableSleep(on: boolean): Promise<boolean> {
  if (inert()) return false
  return (await run('/usr/bin/sudo', ['-n', PMSET, '-a', 'disablesleep', on ? '1' : '0'])).ok
}

export type LidAwakeResult = { ok: true; enabled: boolean } | { ok: false; error: string }

export async function setLidAwake(on: boolean): Promise<LidAwakeResult> {
  if (process.platform !== 'darwin') return { ok: false, error: 'This is for a MacBook.' }
  if (inert()) return { ok: false, error: 'Not available in a test run.' }
  if (!on) {
    await setDisableSleep(false)
    // The rule goes with the setting: no standing permission for a feature that is off.
    await run('/usr/bin/sudo', ['-n', '/bin/rm', '-f', RULE_PATH])
    kvSet(KEY, '0')
    return { ok: true, enabled: false }
  }
  if (!(await setDisableSleep(true))) {
    const user = safeUser(os.userInfo().username)
    if (!user) return { ok: false, error: 'Your macOS user name cannot be used in the rule.' }
    // macOS's own password dialog; the prompt names what is being asked for.
    const asked = await run(
      '/usr/bin/osascript',
      [
        '-e',
        `do shell script ${JSON.stringify(installScript(user))} with prompt "Superagent wants to keep your Mac awake with the lid closed." with administrator privileges`
      ],
      120_000
    )
    if (!asked.ok)
      return {
        ok: false,
        error: /-128|cancel/i.test(asked.err)
          ? 'Cancelled. Nothing was changed.'
          : 'macOS did not allow it. Nothing was changed.'
      }
    if (!(await setDisableSleep(true)))
      return { ok: false, error: 'The permission was installed, but macOS still refused.' }
  }
  kvSet(KEY, '1')
  return { ok: true, enabled: true }
}

/** At launch: on if the setting is on; cleared otherwise, in case a crash left it set. */
export async function applyLidAwake(): Promise<void> {
  if (inert()) return
  await setDisableSleep(lidAwakeEnabled())
}

/** At quit: sleep is the Mac's again. Quick, and best effort. */
export function releaseLidAwake(): void {
  if (inert() || !lidAwakeEnabled()) return
  try {
    execFile('/usr/bin/sudo', ['-n', PMSET, '-a', 'disablesleep', '0'], { timeout: 5000 }, () => {})
  } catch {
    // The next launch clears it.
  }
}

export function registerLidAwakeIpc(): void {
  ipcMain.handle('power:lid-awake', () => lidAwakeEnabled())
  ipcMain.handle('power:set-lid-awake', (_e, on: boolean) => setLidAwake(!!on))
  void applyLidAwake()
}
