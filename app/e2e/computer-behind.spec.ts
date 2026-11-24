import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { spawn, spawnSync, ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Computer use from behind: an agent working in one app's window while the
 * user goes on using the Mac. Called the way an agent calls it (the MCP tools,
 * with the questions answered in the window), against a tiny test app of its
 * own, built as a real .app so it is found by name. The app sits behind every
 * other window and never comes forward; the test checks that what was done
 * reached it, that the app in front stayed in front and the pointer did not
 * move, and that every rule of computer use still holds from behind.
 */

const NAME = 'Superagent AX Target'
const BUNDLE = 'dev.superagent.e2e.axtarget'
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

let app: ElectronApplication
let window: Page
let target: ChildProcess | undefined
let dir: string
let data: string
let bundle: string
let mcpUrl: string
let wsId: string
let chatId: string
let token: string
let log = ''

/** A locked Mac has the login window in front, and apps are not described through it. */
function macLocked(): boolean {
  const front = spawnSync('/usr/bin/lsappinfo', ['front']).stdout?.toString().trim() ?? ''
  const info = spawnSync('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', front])
  return /com\.apple\.loginwindow/.test(info.stdout?.toString() ?? '')
}

/** The bundle id of the app in front: the user's, which must stay in front. */
function frontBundle(): string {
  const front = spawnSync('/usr/bin/lsappinfo', ['front']).stdout?.toString().trim() ?? ''
  const info = spawnSync('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', front])
  return /"([^"]+)"\s*$/m.exec(info.stdout?.toString() ?? '')?.[1] ?? ''
}

async function rpc(
  method: string,
  params: Record<string, unknown>
): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  const res = await fetch(
    `${mcpUrl}?ws=${encodeURIComponent(wsId)}&chat=${encodeURIComponent(chatId)}&k=${token}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    }
  )
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6)
  return JSON.parse(json)
}

type Said = { text: string; isError: boolean; images: number; imageBytes: number }

/** One tool call, answering every question it asks with `answer`. */
async function tool(
  name: string,
  args: Record<string, unknown>,
  answer: (preview: string) => boolean = () => true
): Promise<Said & { asked: string[] }> {
  const asked: string[] = []
  const call = rpc('tools/call', { name, arguments: args })
  let done = false
  void call.finally(() => (done = true))
  // Questions arrive in the window; each is answered as it comes.
  while (!done) {
    const pending = await window.evaluate(() => {
      const g = window as unknown as { asks: { requestId: string; preview: string }[] }
      return g.asks.splice(0)
    })
    for (const a of pending) {
      asked.push(a.preview)
      await window.evaluate(([id, yes]) => window.cove.dotAnswer(id as string, yes as boolean), [
        a.requestId,
        answer(a.preview)
      ] as const)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const msg = await call
  if (msg.error) throw new Error(msg.error.message)
  const r = msg.result as {
    isError?: boolean
    content: { type: string; text?: string; data?: string }[]
  }
  const images = r.content.filter((c) => c.type === 'image')
  return {
    text: r.content.map((c) => c.text ?? '').join('\n'),
    isError: !!r.isError,
    images: images.length,
    imageBytes: images.reduce((n, c) => n + Buffer.from(c.data ?? '', 'base64').length, 0),
    asked
  }
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  const clang = spawnSync('/usr/bin/clang', ['--version'])
  test.skip(
    process.platform !== 'darwin' ||
      clang.status !== 0 ||
      !existsSync(join(__dirname, '..', 'native', 'cuse')),
    'needs a Mac, clang and the built helper'
  )
  test.skip(macLocked(), 'this Mac is locked: accessibility does not describe apps while it is')

  // The test app, as a real .app so Launch Services knows it by name.
  dir = mkdtempSync(join(tmpdir(), 'cove-behind-'))
  bundle = join(dir, `${NAME}.app`)
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(
    join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE}</string>
<key>CFBundleName</key><string>${NAME}</string>
<key>CFBundleExecutable</key><string>ax-target</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`
  )
  const built = spawnSync('/usr/bin/clang', [
    '-fobjc-arc',
    '-framework',
    'Cocoa',
    '-o',
    join(bundle, 'Contents', 'MacOS', 'ax-target'),
    join(__dirname, 'fixtures', 'ax-target.m')
  ])
  expect(built.status, String(built.stderr)).toBe(0)
  spawnSync(LSREGISTER, ['-f', bundle])

  data = mkdtempSync(join(tmpdir(), 'cove-behind-data-'))
  const proj = join(dir, 'proj')
  mkdirSync(proj)
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const urlFile = join(data, 'mcp-url.txt')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_MCP_URL_FILE: urlFile,
      COVE_E2E_BEHIND: '1',
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await expect.poll(() => existsSync(urlFile)).toBe(true)
  mcpUrl = readFileSync(urlFile, 'utf8')
  const made = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces)[0]
    return { wsId: ws.id, chatId: await window.cove.chatCreate(ws.id) }
  })
  wsId = made.wsId
  chatId = made.chatId
  token = await app.evaluate(
    (_e, [ws, chat]) =>
      (globalThis as unknown as { __mcpToken: (ws: string, chat: string) => string }).__mcpToken(
        ws,
        chat
      ),
    [wsId, chatId]
  )
  await window.evaluate(() => {
    const g = window as unknown as { asks: { requestId: string; preview: string }[] }
    g.asks = []
    window.cove.onGuardrailAsk((a) => g.asks.push({ requestId: a.requestId, preview: a.preview }))
  })
  await window.evaluate(() => window.cove.setComputerUse(true))
  const status = await window.evaluate(() => window.cove.computerStatus())
  test.skip(
    !status.accessibility || !status.screen,
    'this Mac has not given the test build Accessibility and Screen Recording'
  )

  // On the screen, behind every other window.
  target = spawn(join(bundle, 'Contents', 'MacOS', 'ax-target'), [], {
    env: { ...process.env, AX_ONSCREEN: '1' }
  })
  target.stdout!.on('data', (d) => (log += String(d)))
  await expect.poll(() => /READY pid=(\d+)/.test(log)).toBe(true)
})

test.afterAll(async () => {
  target?.kill()
  await window?.evaluate(() => window.cove.setComputerUse(false)).catch(() => {})
  await app?.close()
  if (bundle) spawnSync(LSREGISTER, ['-u', bundle])
  for (const d of [dir, data]) if (d) rmSync(d, { recursive: true, force: true })
})

test('the tools offer working from behind', async () => {
  const listed = await rpc('tools/list', {})
  const tools = (
    listed.result as { tools: { name: string; inputSchema: { properties?: object } }[] }
  ).tools
  const by = (n: string): { properties?: object } => tools.find((t) => t.name === n)!.inputSchema
  expect(tools.map((t) => t.name)).toContain('computer_window_screenshot')
  for (const n of [
    'computer_read_ui',
    'computer_press',
    'computer_fill',
    'computer_menu',
    'computer_wait_for'
  ])
    expect(Object.keys(by(n).properties ?? {}), n).toContain('app')
  expect(Object.keys(by('computer_open_mac_app').properties ?? {})).toContain('background')
})

test('an app is read from behind, asked about first, a password never read', async () => {
  const r = await tool('computer_read_ui', { app: NAME })
  expect(r.isError, r.text).toBe(false)
  // The first use asks for the Mac, then for this app by name.
  expect(r.asked.some((q) => q.includes(`Work in ${NAME}`))).toBe(true)
  expect(r.text).toContain('from behind')
  expect(r.text).toMatch(/\[\d+\] button "Press"/)
  expect(r.text).toMatch(/\[\d+\] text field "Name"/)
  expect(r.text).toContain('secure text field "Password" = (hidden)')
  expect(r.text).not.toContain('hunter2')
  // No points: nothing is clicked from behind.
  expect(r.text).not.toMatch(/ at \d+,\d+/)
  // Never brought forward. (The app in front is not compared with before:
  // the person at the Mac goes on using it during the run, as intended.)
  expect(frontBundle()).not.toBe(BUNDLE)
})

test('a button is pressed, a field filled and a menu picked, the user left where they are', async () => {
  // From here on: macOS may activate the test app once as it starts (the
  // fixture hands it straight back); that is not what is checked.
  const mark = log.length
  const ui = (await tool('computer_read_ui', { app: NAME })).text
  const num = (re: RegExp): number => Number(re.exec(ui)![1])

  const pressed = await tool('computer_press', {
    app: NAME,
    index: num(/\[(\d+)\] button "Press"/),
    name: 'Press'
  })
  expect(pressed.isError, pressed.text).toBe(false)
  // Asked only once per conversation: no question this time.
  expect(pressed.asked).toEqual([])
  await expect.poll(() => log, { timeout: 15_000 }).toContain('PRESSED active=0')

  const filled = await tool('computer_fill', {
    app: NAME,
    index: num(/\[(\d+)\] text field "Name"/),
    name: 'Name',
    text: 'Ada Lovelace'
  })
  expect(filled.isError, filled.text).toBe(false)
  await expect.poll(() => log, { timeout: 15_000 }).toContain('FIELD Ada Lovelace')

  const picked = await tool('computer_menu', { app: NAME, path: 'File > Ping' })
  expect(picked.isError, picked.text).toBe(false)
  await expect.poll(() => log, { timeout: 15_000 }).toContain('MENU ping')

  // Nothing came forward. (The pointer is not compared: the person at the Mac
  // moves it during the run. These tools post no mouse event at all.)
  expect(frontBundle()).not.toBe(BUNDLE)
  expect(log.slice(mark), log).not.toContain('ACTIVATED')
})

test('what it saw is that window alone, covered or not', async () => {
  const r = await tool('computer_window_screenshot', { app: NAME })
  expect(r.isError, r.text).toBe(false)
  expect(r.images).toBe(1)
  expect(r.imageBytes).toBeGreaterThan(500)
  // The size of the test app's window, not of a screen.
  expect(r.text).toMatch(/\((\d+)×(\d+)\)/)
  const [, w, h] = /\((\d+)×(\d+)\)/.exec(r.text)!.map(Number)
  expect(w / h).toBeCloseTo(300 / 160, 0)
  expect(w).toBeLessThan(1000)
})

test('nothing is done when the control changed, and never in a password field', async () => {
  const ui = (await tool('computer_read_ui', { app: NAME })).text
  const before = (log.match(/PRESSED/g) ?? []).length
  const wrong = await tool('computer_press', {
    app: NAME,
    index: Number(/\[(\d+)\] button "Press"/.exec(ui)![1]),
    name: 'Delete everything'
  })
  expect(wrong.isError).toBe(true)
  expect(wrong.text).toContain('changed since its controls were read')
  const secret = await tool('computer_fill', {
    app: NAME,
    index: Number(/\[(\d+)\] secure text field "Password"/.exec(ui)![1]),
    name: 'Password',
    text: 'guess'
  })
  expect(secret.isError).toBe(true)
  expect(secret.text).toContain('password field')
  await new Promise((r) => setTimeout(r, 400))
  expect((log.match(/PRESSED/g) ?? []).length).toBe(before)
  expect(log.split('\n').filter(Boolean).pop()).toContain('SECRET hunter2')
  const greyed = await tool('computer_menu', { app: NAME, path: 'File > Greyed' })
  expect(greyed.isError).toBe(true)
})

test('an app that is out of bounds, unknown or not open is refused, and nothing is asked', async () => {
  const keychain = await tool('computer_read_ui', { app: 'Passwords' })
  expect(keychain.isError).toBe(true)
  expect(keychain.asked.filter((q) => q.startsWith('Work in'))).toEqual([])
  expect(keychain.text).toMatch(/secrets|out of bounds/)
  const self = await tool('computer_read_ui', { app: 'Electron' })
  expect(self.isError).toBe(true)
  const unknown = await tool('computer_read_ui', { app: 'No Such App 12345' })
  expect(unknown.isError).toBe(true)
  expect(unknown.text).toContain('no app called')
  const closed = await tool('computer_read_ui', { app: 'Chess' })
  expect(closed.isError).toBe(true)
  expect(closed.text).toMatch(/not open|no app called/)
})

test('a no to the app is final: nothing is read or done there', async () => {
  // A fresh conversation, so the app is asked about again.
  chatId = await window.evaluate((ws) => window.cove.chatCreate(ws), wsId)
  token = await app.evaluate(
    (_e, [ws, chat]) =>
      (globalThis as unknown as { __mcpToken: (ws: string, chat: string) => string }).__mcpToken(
        ws,
        chat
      ),
    [wsId, chatId]
  )
  const before = log.length
  const r = await tool('computer_read_ui', { app: NAME }, (q) => !q.startsWith('Work in'))
  expect(r.isError).toBe(true)
  expect(r.text).toContain('did not allow working in')
  const p = await tool(
    'computer_press',
    { app: NAME, index: 0, name: 'Press' },
    (q) => !q.startsWith('Work in')
  )
  expect(p.isError).toBe(true)
  await new Promise((r) => setTimeout(r, 400))
  expect(log.slice(before)).not.toContain('PRESSED')
})

test('only a real app of its own: a panel another app runs, macOS itself, a terminal or a path are refused', async () => {
  for (const [app, why] of [
    ['Open and Save Panel Service', /part of another app|copies of that running/],
    ['Dock', /part of macOS/],
    ['Terminal', /terminal/],
    ['/System/Applications/Calculator.app', /not by a path/]
  ] as const) {
    const r = await tool('computer_read_ui', { app })
    expect(r.isError, `${app}: ${r.text}`).toBe(true)
    expect(r.text, app).toMatch(why)
    // Refused outright: the user is not asked about it first.
    expect(
      r.asked.filter((q) => q.startsWith('Work in')),
      app
    ).toEqual([])
  }
})

test('a stop takes the yes back, and nothing from behind gives it back', async () => {
  await window.evaluate(() => window.cove.computerStop())
  // The next call has to ask again, and a no leaves it at that.
  const r = await tool('computer_window_screenshot', { app: NAME }, () => false)
  expect(r.isError).toBe(true)
  expect(r.asked.length).toBeGreaterThan(0)
  expect(r.images).toBe(0)
})

test('helpers inside another app, Superagent and System Settings are refused, even to open behind', async () => {
  // Present on most Macs: always checked.
  const settings = await tool('computer_read_ui', { app: 'System Settings' })
  expect(settings.isError).toBe(true)
  expect(settings.text).toMatch(/System Settings is not worked in from behind|not open/)
  const opening = await tool('computer_open_mac_app', { name: 'Terminal', background: true })
  expect(opening.isError).toBe(true)
  expect(opening.text).toContain('terminal')
  // Refused before anything is asked or opened.
  expect(opening.asked.filter((q) => q.startsWith('Work in'))).toEqual([])
  // Only on a Mac that has them: a password manager's helper inside its bundle
  // (team-prefixed id), and the installed Superagent's own helper.
  const known = (name: string): boolean =>
    spawnSync('/usr/bin/osascript', ['-e', `id of app "${name}"`]).status === 0
  for (const name of ['1Password Extension Helper', 'SuperAgent Helper (Plugin)']) {
    if (!known(name)) continue
    const r = await tool('computer_read_ui', { app: name })
    expect(r.isError, `${name}: ${r.text}`).toBe(true)
    expect(
      r.asked.filter((q) => q.startsWith('Work in')),
      name
    ).toEqual([])
  }
})

// A real app of Apple's, not the test's own: opt in, as it opens Calculator
// (behind the user's windows) and quits it again if it was not open before.
test('a real app from behind: Calculator works 7 + 3 without coming forward', async () => {
  test.skip(process.env.BEHIND_REAL !== '1', 'set BEHIND_REAL=1 to try it on Calculator')
  // lsappinfo prints a line even when it finds nothing: look for an ASN.
  const wasOpen = /ASN:/.test(
    spawnSync('/usr/bin/lsappinfo', ['find', 'bundleid=com.apple.calculator']).stdout?.toString() ??
      ''
  )
  try {
    const opened = await tool('computer_open_mac_app', { name: 'Calculator', background: true })
    expect(opened.isError, opened.text).toBe(false)
    expect(frontBundle()).not.toBe('com.apple.calculator')
    const ui = (await tool('computer_read_ui', { app: 'Calculator' })).text
    const num = (label: string): number =>
      Number(new RegExp(`\\[(\\d+)\\] button "${label}"`).exec(ui)?.[1] ?? NaN)
    for (const key of ['All Clear', '7', 'Add', '3', 'Equals']) {
      const r = await tool('computer_press', { app: 'Calculator', index: num(key), name: key })
      expect(r.isError, `${key}: ${r.text}`).toBe(false)
      // Each press returns Calculator's window alone, never coming forward.
      expect(r.images, `${key}: ${r.text}`).toBe(1)
      expect(frontBundle()).not.toBe('com.apple.calculator')
    }
    // The result is read as text in the window, and waited for by it.
    const done = await tool('computer_wait_for', { app: 'Calculator', text: '10', seconds: 5 })
    expect(done.isError, done.text).toBe(false)
    expect(done.text).toContain('was there')
    expect(done.text).toMatch(/Text in the window[\s\S]*"10"/)
  } finally {
    if (!wasOpen) spawnSync('/usr/bin/osascript', ['-e', 'quit app id "com.apple.calculator"'])
  }
})
