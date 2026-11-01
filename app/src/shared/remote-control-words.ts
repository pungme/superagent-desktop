/**
 * The words Remote control uses to say what a phone can do, in one place so the
 * Allow dialog (at the Mac) and the Settings paragraph cannot drift apart. Plain,
 * no absolutes: what Superagent does is a list of known cases, not a wall.
 * `shells`: terminals and scripting apps were allowed at the Mac.
 */

/** What the phone can reach, for how long, and how it ends. */
export function reachWords(): string {
  return 'The phone sees this screen live and can use the mouse and keyboard as you, in nearly any app, for up to 2 hours. It ends after 10 minutes without input, when the phone disconnects, or when you press ⌥Esc or Stop. That includes Mail and Messages (including one-time codes, and sending as you), Finder and every file, sites you are signed in to, and restarting the Mac, and nothing it did is undone afterwards.'
}

/** What Superagent does about it, and that it is not a guarantee. */
export function limitsWords(shells: boolean): string {
  return `Superagent tries to keep it away from password managers, macOS password and permission prompts${shells ? '' : ', terminals'} and Superagent's own windows: it pauses the picture while a password manager or prompt is up, covers its own windows and hides notifications. That is a list of known cases, not a guarantee: a browser's saved logins, a copied password and other routes to running commands can still get through.${shells ? ' You allowed terminals, so it can run commands as you.' : ''} Superagent's Dock icon is hidden while a session runs.`
}

/** The habit that defeats the rest. */
export function habitWords(): string {
  return 'If a Touch ID or password prompt appears and you approve it out of habit, the phone gets what it asked for. Allow it only when you just asked for it on your own phone, and stay near the Mac.'
}

/** The Allow dialog's detail text. */
export function dialogWords(deviceName: string, shells: boolean): string {
  return [`Paired phone: ${deviceName}`, reachWords(), limitsWords(shells), habitWords()].join(
    '\n\n'
  )
}

/** The Settings paragraph under "Let my phone control this Mac". */
export function settingsWords(shells: boolean): string {
  return `${reachWords()} ${limitsWords(shells)} ${habitWords()} Each time, this Mac asks you and shows a code. This stays on after a restart until you turn it off.`
}
