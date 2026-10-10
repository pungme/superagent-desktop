/**
 * The agent's own shell must not be a second way to the mouse, the keyboard or
 * the screen. Computer use goes through the computer_* tools, where the user is
 * asked, some apps are out of bounds and ⌥Esc stops it; a shell command that
 * posts events or photographs the screen would have none of that.
 *
 * This reads a command the way sim-guard.ts does: a list of the known ways,
 * not a proof. It stops the ordinary routes and says why, so an agent that
 * meant well is pointed at the tools.
 */

const WAYS: [pattern: RegExp, what: string][] = [
  // Superagent's own helper, by name or path.
  [/(^|[\s;&|(`'"/])cuse(["'`\s;&|)]|$)/, 'runs the computer-use helper directly'],
  // AppleScript / JXA driving the keyboard or mouse through System Events.
  [
    /osascript[\s\S]*(system events|systemevents)[\s\S]*(keystroke|key code|key down|click|perform action)/i,
    'drives the keyboard or mouse through System Events'
  ],
  [/osascript[\s\S]*(keystroke|key code)\b/i, 'types through AppleScript'],
  [
    /\b(cliclick|xdotool|ydotool|skhd\s+-k|hidutil\s+property\s+--set)\b/i,
    'posts mouse or keyboard events'
  ],
  [
    /\b(CGEventPost|CGEventCreateMouseEvent|CGEventCreateKeyboardEvent|CGWarpMouseCursorPosition|AXUIElementPerformAction|IOHIDPostEvent)\b/,
    'posts mouse or keyboard events'
  ],
  [
    /\b(pyautogui|pynput|robotjs|nut-js|nutjs|enigo|autopy|keyboard\.press|mouse\.click)\b/i,
    'posts mouse or keyboard events'
  ],
  // The screen, outside the consent and the apps that are out of bounds.
  [/(^|[\s;&|(`'"/])screencapture(["'`\s;&|)]|$)/, "photographs the user's screen"],
  [
    /\b(CGDisplayCreateImage|CGWindowListCreateImage|SCScreenshotManager|ImageGrab\.grab|mss\(\))/,
    "photographs the user's screen"
  ],
  // Granting itself the permissions, or resetting them.
  [/\btccutil\b/, "changes this Mac's privacy permissions"],
  [/TCC\.db/, "changes this Mac's privacy permissions"]
]

/** Why this command is refused, or null when it has nothing to do with it. */
export function computerShellVerdict(command: string): string | null {
  const hit = WAYS.find(([pattern]) => pattern.test(command))
  if (!hit) return null
  return (
    `Blocked by Superagent: this command ${hit[1]}. The mouse, the keyboard and the screen are only ` +
    'reached through the computer_* tools, where the user is asked first and can stop it; if those ' +
    'tools are not there, computer use is turned off and the user has not agreed to it. Do not look ' +
    'for another way: say what you wanted to do and let the user decide.'
  )
}

/** Called before a shell tool runs; null lets it through. */
export function computerBeforeShell(toolName: string, input: unknown): string | null {
  // Claude's shell, and Antigravity's.
  if (!/^(Bash|run_command|run_terminal_command|shell)$/i.test(toolName)) return null
  const command = (input as { command?: unknown } | null)?.command
  return typeof command === 'string' && command ? computerShellVerdict(command) : null
}
