import { BrowserWindow, dialog, app, screen } from 'electron'
import { allowDialog, quietRun, spacedCode } from '../../shared/remote-control'
import type { DisplayInfo } from './control'

/**
 * What remote control puts on the Mac's screen: the banner that is there for
 * as long as a phone is working this Mac, and the two native questions that
 * start it.
 *
 * None of it can be answered by the phone. The banner and the dialogs are
 * Superagent's own windows, and remote input is refused wherever it would land
 * on one (control.ts: the app under the pointer is Superagent, or the point is
 * inside one of its windows, or one of them holds the keyboard). The dialogs
 * are native panels, not BrowserWindows: the helper's `at` reports them as
 * Superagent's, which is what keeps a click on their buttons refused.
 */

const STOP_URL = 'sa-remote://stop'
const WIDTH = 440
const HEIGHT = 40

// A test run only, and never a packaged app (shared/remote-control.ts quietRun).
const quiet = (): boolean => quietRun(process.env, app.isPackaged)

export function bannerHtml(device: string): string {
  const what = /ipad/i.test(device) ? 'iPad' : 'iPhone'
  return `<!doctype html><meta charset="utf-8"><title>Remote control</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:transparent;font:600 13px -apple-system,system-ui,sans-serif;-webkit-user-select:none;user-select:none}
  .bar{box-sizing:border-box;height:100%;margin:0;display:flex;align-items:center;justify-content:center;gap:10px;
    background:#c8281e;color:#fff;border-radius:10px;padding:0 14px;box-shadow:0 2px 10px rgba(0,0,0,.35)}
  a{color:#c8281e;background:#fff;text-decoration:none;border-radius:6px;padding:3px 12px;cursor:pointer}
</style>
<div class="bar"><span>Your ${what} is controlling this Mac</span><a href="${STOP_URL}">Stop</a></div>`
}

/**
 * The banner, one on every display (a phone sees only the shared one, but
 * whoever is at the Mac may be looking at another). `onStop` is called when
 * someone at the Mac chooses Stop in it. Below the menu bar, so it does not sit
 * on the notch or the Apple menu.
 */
export function createBanner(onStop: () => void): {
  show: (info: { deviceName: string; display: DisplayInfo; displays: DisplayInfo[] }) => boolean
  hide: () => void
  ok: () => boolean
  bounds: () => Electron.Rectangle[]
} {
  let wins: BrowserWindow[] = []

  const hide = (): void => {
    const all = wins
    wins = []
    for (const w of all) if (!w.isDestroyed()) w.destroy()
  }

  const one = (deviceName: string, b: Electron.Rectangle, topInset: number): BrowserWindow => {
    const w = new BrowserWindow({
      x: Math.round(b.x + (b.width - WIDTH) / 2),
      y: b.y + Math.max(6, topInset + 4),
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      // Not a window that takes the keyboard or makes Superagent the app in
      // front: a click on Stop is a click, nothing more.
      focusable: false,
      type: 'panel',
      hasShadow: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    // Over every space and full-screen apps, but without turning Superagent into a
    // background app: without skipTransformProcessType its Dock icon disappears
    // (measured on Electron 39) and does not come back.
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    // No script, no navigation but the one link: Stop.
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.webContents.on('will-navigate', (e, url) => {
      e.preventDefault()
      if (url === STOP_URL) onStop()
    })
    void w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(bannerHtml(deviceName)))
    // A quiet test run shows no windows; everything else is as in life.
    if (!quiet()) w.showInactive()
    return w
  }

  return {
    show({ deviceName, display, displays }) {
      hide()
      try {
        const real = screen.getAllDisplays()
        const all = displays.some((d) => d.id === display.id) ? displays : [display, ...displays]
        for (const d of all) {
          const work = real.find((x) => x.id === d.id)
          // The menu bar's depth: where the usable area starts below the display's top.
          const inset = work ? work.workArea.y - work.bounds.y : 0
          wins.push(one(deviceName, d.bounds, inset))
        }
        return wins.length > 0
      } catch {
        hide()
        return false
      }
    },
    hide,
    // Every one of them still there, or the session ends: a banner that has gone is not telling anyone.
    ok: () => wins.length > 0 && wins.every((w) => !w.isDestroyed() && (quiet() || w.isVisible())),
    bounds: () => wins.filter((w) => !w.isDestroyed()).map((w) => w.getBounds())
  }
}

/** Bring Superagent to the front so the question is seen, unless this is a quiet test run. */
function forward(): void {
  if (!quiet()) app.focus({ steal: true })
}

/**
 * "Allow your iPhone to control this Mac?" A native dialog, Don't allow by
 * default (Return and Esc both mean no), one Allow button per display when
 * there are several so the choice of what is shared is made here too.
 */
export async function askAllowDialog(q: {
  deviceName: string
  shells: boolean
  displays: DisplayInfo[]
  signal: AbortSignal
}): Promise<{ allow: false } | { allow: true; displayId: number }> {
  forward()
  const shown = q.displays.slice(0, 4)
  if (!shown.length) return { allow: false }
  const many = shown.length > 1
  const r = await dialog.showMessageBox({
    type: 'warning',
    title: 'Superagent',
    ...allowDialog(q.deviceName, q.shells),
    buttons: ["Don't allow", ...shown.map((d) => (many ? `Allow on ${d.name}` : 'Allow'))],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal: q.signal
  })
  const picked = r.response - 1
  return picked >= 0 && picked < shown.length && !q.signal.aborted
    ? { allow: true, displayId: shown[picked].id }
    : { allow: false }
}

/** The code, on the Mac's screen, until the phone has typed it, or someone chooses Cancel. */
export async function showCodeDialog(q: {
  deviceName: string
  code: string
  signal: AbortSignal
}): Promise<void> {
  forward()
  await dialog.showMessageBox({
    type: 'info',
    title: 'Superagent',
    message: `Type ${spacedCode(q.code)} on the phone`,
    detail: `Paired phone: ${q.deviceName}\n\nRemote control starts when the code is typed on the phone. Cancel if you did not ask for this.`,
    buttons: ['Cancel'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal: q.signal
  })
}
