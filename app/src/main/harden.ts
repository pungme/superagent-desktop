import { app, BrowserWindow } from 'electron'
import { forbiddenSwitch, testOnlyEnv } from '../shared/harden'

/**
 * First thing the main process does (index.ts imports this before anything
 * else, so before any module reads the environment). See shared/harden.ts for
 * why. Nothing here applies to a development or test run, which is not the
 * app macOS gave its permissions to.
 */
if (app.isPackaged) {
  const bad = forbiddenSwitch(process.argv)
  if (bad) {
    console.error(`Superagent does not start with ${bad.split('=')[0]}.`)
    app.exit(1)
  }
  for (const k of testOnlyEnv(process.env)) delete process.env[k]
  // One Superagent at a time. A second copy would have the first one's
  // permissions and none of its state: not the Stop key, not what was allowed.
  if (!app.requestSingleInstanceLock()) app.exit(0)
  // Asked to start again: the one that is running comes forward instead.
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isAlwaysOnTop())
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
}

/**
 * A test of dictation hears a spoken file instead of the microphone (never in a
 * packaged build: the variable is stripped above). Set here, before the app is
 * ready, because Chromium reads these switches at start.
 */
if (!app.isPackaged && process.env.COVE_E2E_FAKE_AUDIO) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.COVE_E2E_FAKE_AUDIO)
  // The audio service runs sandboxed in its own process, where it cannot open the file.
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,AudioServiceSandbox')
}
