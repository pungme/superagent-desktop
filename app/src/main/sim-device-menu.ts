import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

/**
 * The simulator pane's Device menu: what Simulator.app's Features and Device
 * menus do, from the pane. A real macOS menu, so it draws over the embedded
 * screen (a page's menu would be hidden under it).
 *
 * Everything here goes through simctl, or posts the notification inside the
 * device that Simulator.app posts (Face ID, Touch ID, shake).
 */

const simctl = (args: string[], timeout = 15_000): Promise<string> =>
  run('xcrun', ['simctl', ...args], { timeout }).then((r) => r.stdout.trim())

/** Post a Darwin notification inside the device, as Simulator.app does. */
const notify = (udid: string, name: string): Promise<string> =>
  simctl(['spawn', udid, 'notifyutil', '-p', name])

const PLACES: [label: string, lat: number, lon: number][] = [
  ['Apple Park', 37.3349, -122.009],
  ['Munich', 48.1374, 11.5755],
  ['London', 51.5072, -0.1276],
  ['New York', 40.7128, -74.006],
  ['Tokyo', 35.6762, 139.6503]
]

const TEXT_SIZES: [label: string, size: string][] = [
  ['Smaller', 'small'],
  ['Default', 'large'],
  ['Larger', 'extra-large'],
  ['Largest (Accessibility)', 'accessibility-extra-extra-extra-large']
]

/** A recording per device while one is running. */
const recordings = new Map<string, { proc: ChildProcess; file: string }>()

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

function startRecording(udid: string): void {
  if (recordings.has(udid)) return
  const file = join(app.getPath('desktop'), `Simulator Recording ${stamp()}.mov`)
  const proc = spawn(
    'xcrun',
    ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file],
    {
      stdio: 'ignore'
    }
  )
  proc.on('exit', () => {
    if (recordings.get(udid)?.proc === proc) recordings.delete(udid)
  })
  recordings.set(udid, { proc, file })
}

function stopRecording(udid: string): void {
  const r = recordings.get(udid)
  if (!r) return
  recordings.delete(udid)
  // recordVideo finishes the file on SIGINT, as Ctrl-C in a terminal would.
  r.proc.once('exit', () => shell.showItemInFolder(r.file))
  r.proc.kill('SIGINT')
}

export function isRecording(udid: string): boolean {
  return recordings.has(udid)
}

export function stopAllRecordings(): void {
  for (const udid of [...recordings.keys()]) stopRecording(udid)
}

async function screenshot(udid: string): Promise<void> {
  const file = join(app.getPath('desktop'), `Simulator Screenshot ${stamp()}.png`)
  await simctl(['io', udid, 'screenshot', file], 20_000)
  shell.showItemInFolder(file)
}

/** Touch ID devices: a home button, or an iPad with the sensor in the top button. */
function touchIdDevice(name: string): boolean {
  return /iPhone SE|iPad \(|iPad Air|iPad mini/i.test(name)
}

async function build(
  udid: string,
  name: string,
  done: (error?: string) => void,
  chose: () => void
): Promise<MenuItemConstructorOptions[]> {
  const act = (fn: () => Promise<unknown>) => (): void => {
    chose()
    void fn().then(
      () => done(),
      (err) => done(String((err as Error)?.message ?? err).slice(0, 200))
    )
  }
  const [appearance, textSize] = await Promise.all([
    simctl(['ui', udid, 'appearance']).catch(() => ''),
    simctl(['ui', udid, 'content_size']).catch(() => '')
  ])
  const touchId = touchIdDevice(name)
  const bio = touchId ? 'Touch ID' : 'Face ID'
  const prefix = touchId
    ? 'com.apple.BiometricKit_Sim.fingerTouch'
    : 'com.apple.BiometricKit_Sim.pearl'
  const recording = recordings.has(udid)
  return [
    {
      label: 'Appearance',
      submenu: (['light', 'dark'] as const).map((a) => ({
        label: a === 'light' ? 'Light' : 'Dark',
        type: 'radio' as const,
        checked: appearance === a,
        click: act(() => simctl(['ui', udid, 'appearance', a]))
      }))
    },
    {
      label: 'Text Size',
      submenu: TEXT_SIZES.map(([label, size]) => ({
        label,
        type: 'radio' as const,
        checked: textSize === size,
        click: act(() => simctl(['ui', udid, 'content_size', size]))
      }))
    },
    {
      label: 'Location',
      submenu: [
        ...PLACES.map(([label, lat, lon]) => ({
          label,
          click: act(() => simctl(['location', udid, 'set', `${lat},${lon}`]))
        })),
        { type: 'separator' as const },
        { label: 'None', click: act(() => simctl(['location', udid, 'clear'])) }
      ]
    },
    {
      label: bio,
      submenu: [
        {
          label: 'Enrolled',
          click: act(async () => {
            await simctl([
              'spawn',
              udid,
              'notifyutil',
              '-s',
              'com.apple.BiometricKit.enrollmentChanged',
              '1'
            ])
            await notify(udid, 'com.apple.BiometricKit.enrollmentChanged')
          })
        },
        { type: 'separator' as const },
        {
          label: touchId ? 'Matching Touch' : 'Matching Face',
          click: act(() => notify(udid, `${prefix}.match`))
        },
        {
          label: touchId ? 'Non-matching Touch' : 'Non-matching Face',
          click: act(() => notify(udid, `${prefix}.nomatch`))
        }
      ]
    },
    { type: 'separator' },
    { label: 'Shake', click: act(() => notify(udid, 'com.apple.UIKit.SimulatorShake')) },
    { type: 'separator' },
    { label: 'Save Screenshot', click: act(() => screenshot(udid)) },
    recording
      ? { label: 'Stop Recording', click: act(async () => stopRecording(udid)) }
      : { label: 'Record Screen', click: act(async () => startRecording(udid)) }
  ]
}

export function registerSimDeviceMenu(): void {
  ipcMain.handle(
    'sim:device-menu',
    async (e, udid: string, name: string, at: { x: number; y: number }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win || !udid) return { ok: false, error: 'no window' }
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let settled = false
        const done = (error?: string): void => {
          if (settled) return
          settled = true
          resolve(error ? { ok: false, error } : { ok: true })
        }
        let chosen = false
        void build(String(udid), String(name ?? ''), done, () => (chosen = true)).then((items) => {
          Menu.buildFromTemplate(items).popup({
            window: win,
            x: Math.round(at?.x ?? 0),
            y: Math.round(at?.y ?? 0),
            // Closed without a choice: nothing to report. (A choice reports
            // when its action has finished.)
            callback: () => setTimeout(() => !chosen && done(), 100)
          })
        })
      })
    }
  )
  ipcMain.handle('sim:recording', (_e, udid: string) => isRecording(String(udid)))
}
