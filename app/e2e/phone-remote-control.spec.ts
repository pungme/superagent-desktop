import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'
import WebSocket from 'ws'
import { build } from 'esbuild'
import { deriveKeys, aadFor, Sealer, Opener } from '../src/main/companion/crypto'
import type { PairPayload, ServerFrame, WireRemote } from '../src/shared/companion-protocol'

/**
 * Remote control end to end, with a fake phone: the real app, a real relay, the
 * real encrypted protocol, the real validation and the real session logic.
 * What it never does is touch this Mac. Under a test run (COVE_USER_DATA) the
 * helper is a recorder (what it was asked to post is read back), the screen is
 * a drawing, the two questions at the Mac are answered by the test, and what is
 * in front is whatever the test says. Not one real pointer or key event.
 *
 * Needs the relay repo beside this one; skips itself without it.
 */

const relayDir = join(__dirname, '..', '..', '..', 'superagent-relay')
const hasRelay = existsSync(join(relayDir, 'src', 'node.ts'))

let app: ElectronApplication
let window: Page
let userDataDir: string
let relay: { close: () => void; address: () => AddressInfo | string | null } | null = null

class FakePhone {
  ws!: WebSocket
  sealer: Sealer
  opener: Opener
  inbox: ServerFrame[] = []
  seen: ServerFrame[] = []
  waiters: ((f: ServerFrame) => void)[] = []
  constructor(
    private url: string,
    secret: Buffer,
    machine: string
  ) {
    const keys = deriveKeys(secret, machine)
    this.sealer = new Sealer(keys.p2m, aadFor(machine, 'p2m'))
    this.opener = new Opener(keys.m2p, aadFor(machine, 'm2p'))
  }
  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url)
    this.ws.on('message', (d) => {
      const text = d.toString()
      if (text.startsWith('{')) return
      const plain = this.opener.open(text)
      if (plain === null) throw new Error('phone could not decrypt a frame')
      const f = JSON.parse(plain) as ServerFrame
      this.seen.push(f)
      const w = this.waiters.shift()
      if (w) w(f)
      else this.inbox.push(f)
    })
    await new Promise<void>((r) => this.ws.once('open', () => r()))
  }
  send(frame: unknown): void {
    this.ws.send(this.sealer.seal(JSON.stringify(frame)))
  }
  next(): Promise<ServerFrame> {
    const q = this.inbox.shift()
    return q ? Promise.resolve(q) : new Promise((r) => this.waiters.push(r))
  }
  async until(pred: (f: ServerFrame) => boolean, ms = 10_000): Promise<ServerFrame> {
    const end = Date.now() + ms
    for (;;) {
      const left = end - Date.now()
      if (left <= 0) throw new Error('timed out waiting for a frame')
      const f = await Promise.race([
        this.next(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('timed out waiting for a frame')), left)
        )
      ])
      if (pred(f)) return f
    }
  }
  /** A frame that arrived after `from` frames had, whether or not something else already read past it. */
  async waitFor(pred: (f: ServerFrame) => boolean, from = 0, ms = 10_000): Promise<ServerFrame> {
    const end = Date.now() + ms
    for (;;) {
      const hit = this.seen.slice(from).find(pred)
      if (hit) return hit
      if (Date.now() > end) throw new Error('timed out waiting for a frame')
      await new Promise((r) => setTimeout(r, 40))
    }
  }
  private n = 0
  async ask(
    method: string,
    params?: unknown
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
    const id = `r${++this.n}`
    this.send({ t: 'req', id, method, params })
    return (await this.until(
      (f) => f.t === 'res' && (f as { id?: string }).id === id
    )) as unknown as { ok: boolean; result?: unknown; error?: { code: string; message: string } }
  }
  count(pred: (f: ServerFrame) => boolean): number {
    return this.seen.filter(pred).length
  }
}

let phone: FakePhone
let hello: { token: string; url: string; secret: Buffer; machine: string }

const remoteState = (f: ServerFrame): WireRemote | null => (f.t === 'remote' ? f.remote : null)

/** The test's hands in the app's main process: answers the dialogs, reads what the helper was asked. */
/* eslint-disable @typescript-eslint/no-explicit-any */
const world = <T>(fn: (w: Record<string, any>, h: Record<string, any>) => T): Promise<T> =>
  app.evaluate((_e, src) => {
    const g = globalThis as unknown as Record<string, Record<string, unknown>>

    return new Function('w', 'h', `return (${src})(w, h)`)(g.__remoteWorld, g.__remoteTest)
  }, fn.toString()) as Promise<T>

async function startSession(): Promise<string> {
  const mark = phone.seen.length
  const asked = await phone.ask('remote.request')
  expect(asked).toMatchObject({ ok: true, result: { state: 'asking' } })
  await expect.poll(() => world((w) => w.asks.length)).toBe(1)
  await world((_w, h) => h.answerAsk(true))
  await phone.waitFor((f) => remoteState(f)?.state === 'code', mark)
  const code = (await world((_w, h) => h.lastCode())) as string
  expect(code).toMatch(/^\d{6}$/)
  return code
}

async function connectPhone(): Promise<void> {
  phone?.ws.close()
  phone = new FakePhone(hello.url, hello.secret, hello.machine)
  await phone.connect()
  phone.send({ t: 'hello', v: 1, device: 'iphone-e2e', token: hello.token, app: 'ios/e2e' })
}

test.describe.configure({ mode: 'serial' })
test.skip(!hasRelay, 'needs the relay repo beside this one')

test.beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'cove-relay-')), 'relay.cjs')
  await build({
    entryPoints: [join(relayDir, 'src', 'node.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    nodePaths: [join(__dirname, '..', 'node_modules')],
    logLevel: 'silent'
  })
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startRelay } = require(out) as { startRelay: (port: number) => NonNullable<typeof relay> }
  relay = startRelay(0)
  await new Promise((r) => setTimeout(r, 100))
  const relayPort = (relay.address() as AddressInfo).port

  userDataDir = mkdtempSync(join(tmpdir(), 'cove-remote-data-'))
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
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

  const { payload } = (await window.evaluate(() => window.cove.companionPairStart())) as {
    payload: PairPayload
  }
  await expect
    .poll(() => window.evaluate(async () => (await window.cove.companionState()).relay.state), {
      timeout: 15_000
    })
    .toBe('connected')
  const secret = Buffer.from(payload.k, 'base64url')
  const url = `ws://127.0.0.1:${relayPort}/c/${payload.m}`
  const pairing = new FakePhone(url, secret, payload.m)
  await pairing.connect()
  pairing.send({
    t: 'pair',
    device: { id: 'iphone-e2e', name: 'Test iPhone', model: 'iPhone17,1' }
  })
  await new Promise((r) => setTimeout(r, 300))
  await window.evaluate(() => window.cove.companionPairDecide(true))
  const paired = (await pairing.until((f) => f.t === 'paired')) as { token: string }
  pairing.ws.close()
  hello = { token: paired.token, url, secret, machine: payload.m }
})

test.afterAll(async () => {
  phone?.ws.close()
  await app?.close()
  relay?.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

test('off by default: the Mac does not advertise it and refuses to start', async () => {
  await connectPhone()
  const welcome = (await phone.until((f) => f.t === 'welcome')) as Extract<
    ServerFrame,
    { t: 'welcome' }
  >
  expect(welcome.machine.remoteControl).toBeUndefined()
  for (const m of ['remote.request', 'remote.code', 'remote.input', 'remote.view'])
    expect(await phone.ask(m, m === 'remote.code' ? { code: '123456' } : {})).toMatchObject({
      ok: false
    })
  expect(await world((w) => w.calls.length)).toBe(0)
  expect(await world((w) => w.bannerShown)).toBe(0)
})

test('switching it on at the Mac advertises it, and a new phone connection hears it in welcome', async () => {
  const heard = phone.until((f) => remoteState(f)?.available === true)
  const st = await window.evaluate(() => window.cove.setRemoteControl(true))
  expect(st).toMatchObject({ enabled: true, active: false })
  await heard
  await connectPhone()
  const welcome = (await phone.until((f) => f.t === 'welcome')) as Extract<
    ServerFrame,
    { t: 'welcome' }
  >
  expect(welcome.machine.remoteControl).toBe(true)
  await phone.until((f) => remoteState(f)?.available === true)
})

test('a connection that has not said hello gets nothing from remote control', async () => {
  const stranger = new FakePhone(hello.url, hello.secret, hello.machine)
  await stranger.connect()
  // The key probe has passed (it is the paired phone's key) but no hello with the token.
  const r = await stranger.ask('remote.request')
  expect(r).toMatchObject({ ok: false, error: { message: expect.stringMatching(/hello/i) } })
  expect(await world((w) => w.asks.length)).toBe(0)
  stranger.ws.close()
})

test('the phone cannot allow its own session: only the Mac can', async () => {
  const asked = await phone.ask('remote.request')
  expect(asked).toMatchObject({ ok: true, result: { state: 'asking' } })
  await expect.poll(() => world((w) => w.asks.length)).toBe(1)
  // Everything a phone could try while the Mac's question is open.
  expect(await phone.ask('remote.code', { code: '000000' })).toMatchObject({
    ok: true,
    result: { state: 'asking' }
  })
  expect(await phone.ask('remote.allow', { allow: true })).toMatchObject({ ok: false })
  expect(await phone.ask('remote.approve', {})).toMatchObject({ ok: false })
  expect(
    await phone.ask('remote.input', { actions: [{ type: 'click', x: 0.5, y: 0.5 }] })
  ).toMatchObject({ ok: false })
  expect(await phone.ask('remote.request')).toMatchObject({ ok: false })
  expect(await world((w) => w.calls.length)).toBe(0)
  expect(await world((w) => w.bannerShown)).toBe(0)
  expect(await world((_w, h) => h.control.summary().active)).toBe(false)
  // Don't allow, at the Mac.
  const m1 = phone.seen.length
  await world((_w, h) => h.answerAsk(false))
  await phone.waitFor((f) => remoteState(f)?.ended === 'denied', m1)
})

test('a session: Allow at the Mac, then the code, then the screen and the input', async () => {
  // Past the few seconds a phone has to wait after being turned down.
  await new Promise((r) => setTimeout(r, 5500))
  const code = await startSession()
  const wrong = code === '000000' ? '000001' : '000000'
  const bad = await phone.ask('remote.code', { code: wrong })
  expect(bad).toMatchObject({ ok: false })
  expect(bad.error?.message).toMatch(/2 tries left/)
  expect(await world((w) => w.bannerShown)).toBe(0)
  const good = await phone.ask('remote.code', { code })
  expect(good).toMatchObject({ ok: true, result: { state: 'active' } })
  expect(await world((w) => w.bannerUp)).toBe(true)
  expect(await world((w) => w.stopKeyHeld)).toBe(true)

  // The screen: a whole picture first, a real JPEG, through the real relay.
  const screen = (await phone.until((f) => f.t === 'screen' && f.frame.jpeg !== '')) as Extract<
    ServerFrame,
    { t: 'screen' }
  >
  expect(screen.frame).toMatchObject({ key: true, x: 0, y: 0, w: 640, h: 400 })
  const bytes = Buffer.from(screen.frame.jpeg, 'base64')
  expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff')
  expect(bytes.length).toBeLessThan(540_000)
  expect(screen.frame.cursor).toBeTruthy()

  // The drawing moves, so later frames are pieces of it, smaller than the first.
  const piece = (await phone.until(
    (f) => f.t === 'screen' && f.frame.jpeg !== '' && !f.frame.key
  )) as Extract<ServerFrame, { t: 'screen' }>
  expect(piece.frame.rw * piece.frame.rh).toBeLessThan(640 * 400)

  // Input, in order, validated, through the helper (the recorder here).
  await world((w) => (w.calls.length = 0))
  const res = await phone.ask('remote.input', {
    actions: [
      { type: 'click', x: 0.5, y: 0.5 },
      { type: 'key', key: 'space', mods: ['cmd'] },
      { type: 'text', text: 'hello 👋' },
      { type: 'scroll', x: 0.25, y: 0.5, dx: 0, dy: 0.1 },
      { type: 'click', x: 1, y: 1, button: 'right', count: 2 }
    ]
  })
  expect(res).toMatchObject({ ok: true, result: { done: 5 } })
  expect(await world((w) => w.calls)).toEqual([
    ['tap', '720', '450', 'left', '1'],
    ['key', 'cmd+space'],
    ['type', 'hello 👋'],
    ['wheel', '360', '450', '0', '90'],
    ['tap', '1439', '899', 'right', '2']
  ])
})

test('the validation is the real one: bad frames never reach the helper', async () => {
  await world((w) => (w.calls.length = 0))
  for (const actions of [
    [{ type: 'click', x: 2, y: 0 }],
    [{ type: 'key', key: 'power' }],
    [{ type: 'text', text: 'a\nb' }],
    [{ type: 'move', x: 0, y: 0, shell: 'x' }],
    [{ type: 'run', cmd: 'ls' }],
    []
  ])
    expect(await phone.ask('remote.input', { actions })).toMatchObject({
      ok: false,
      error: { code: 'bad-params' }
    })
  expect(await world((w) => w.calls.length)).toBe(0)
})

test('it refuses where it must: secrets, its own windows, the keys that get round it', async () => {
  // Many round trips through the relay and a real Electron main process: under a
  // loaded machine it has taken longer than the default minute once.
  test.setTimeout(120_000)
  const input = (a: Record<string, unknown>): ReturnType<FakePhone['ask']> =>
    phone.ask('remote.input', { actions: [a] })
  await world((w) => (w.calls.length = 0))

  // A password manager in front.
  const mark = phone.seen.length
  await world((w) => (w.front = { id: 'com.1password.1password', name: '1Password' }))
  expect(await input({ type: 'click', x: 0.5, y: 0.5 })).toMatchObject({ ok: false })
  expect(await input({ type: 'text', text: 'hunter2-secret' })).toMatchObject({ ok: false })
  // The stream goes paused, and the phone is told.
  const paused = (await phone.waitFor((f) => remoteState(f)?.paused === 'secret', mark)) as Extract<
    ServerFrame,
    { t: 'remote' }
  >
  expect(paused.remote.pausedBy).toBe('1Password')
  // No picture while it is paused.
  await new Promise((r) => setTimeout(r, 300))
  const before = phone.count((f) => f.t === 'screen' && f.frame.jpeg !== '')
  await new Promise((r) => setTimeout(r, 1500))
  expect(phone.count((f) => f.t === 'screen' && f.frame.jpeg !== '')).toBe(before)

  // Superagent's own window in front, then under the pointer, then holding keys.
  // (Out of the password manager, the stream picks up again with a whole picture.)
  const resumeMark = phone.seen.length
  await world((w) => (w.front = { id: 'dev.superagent.app', name: 'Superagent' }))
  expect(await input({ type: 'click', x: 0.5, y: 0.5 })).toMatchObject({ ok: false })
  expect(await input({ type: 'key', key: 'return' })).toMatchObject({ ok: false })
  await world((w) => {
    w.front = { id: 'com.test.notes', name: 'Notes' }
    w.under = { id: 'dev.superagent.app', name: 'Superagent' }
  })
  // No wait for the stream here: every action looks at the Mac itself.
  expect(await input({ type: 'click', x: 0.5, y: 0.5 })).toMatchObject({ ok: false })
  await world((w) => {
    w.under = null
    w.ownFocused = true
  })
  expect(await input({ type: 'key', key: 'return' })).toMatchObject({ ok: false })
  await world((w) => (w.ownFocused = false))

  // The keys that bypass the rest.
  expect(await input({ type: 'key', key: 'escape', mods: ['opt'] })).toMatchObject({ ok: false })
  expect(await input({ type: 'key', key: 'escape', mods: ['cmd', 'opt'] })).toMatchObject({
    ok: false
  })
  expect(await input({ type: 'key', key: 'q', mods: ['cmd', 'shift'] })).toMatchObject({
    ok: false
  })

  // Nothing of that reached the helper.
  expect(await world((w) => w.calls)).toEqual([])

  // Back to ordinary: the stream resumes, with a whole picture, and input works.
  await world((w) => {
    w.front = { id: 'com.test.notes', name: 'Notes' }
    w.under = null
    w.ownFocused = false
  })
  await phone.waitFor(
    (f) => remoteState(f)?.paused === null && remoteState(f)?.state === 'active',
    resumeMark
  )
  await phone.waitFor((f) => f.t === 'screen' && f.frame.jpeg !== '' && f.frame.key, resumeMark)
  expect(await input({ type: 'click', x: 0.1, y: 0.1 })).toMatchObject({ ok: true })
  expect(await world((w) => w.calls)).toEqual([['tap', '144', '90', 'left', '1']])

  // A terminal in front: nothing is typed into it, however it got there.
  await world((w) => {
    w.calls.length = 0
    w.front = { id: 'com.apple.Terminal', name: 'Terminal' }
  })
  expect(await input({ type: 'text', text: 'security dump-keychain' })).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/Terminal/) }
  })
  expect(await input({ type: 'key', key: 'return' })).toMatchObject({ ok: false })
  expect(await world((w) => w.calls)).toEqual([])
  // Until the person at the Mac allows terminals and scripting apps, there, and only there.
  expect(
    ((await window.evaluate(() => window.cove.remoteStatus())) as { shells: boolean }).shells
  ).toBe(false)
  await window.evaluate(() => window.cove.setRemoteShells(true))
  expect(await input({ type: 'text', text: 'ls' })).toMatchObject({ ok: true })
  expect(await world((w) => w.calls)).toEqual([['type', 'ls']])
  await window.evaluate(() => window.cove.setRemoteShells(false))
  await world((w) => {
    w.calls.length = 0
    w.front = { id: 'com.test.notes', name: 'Notes' }
  })
})

test('Stop at the Mac ends it at once, and the next session needs the Mac again', async () => {
  const m3 = phone.seen.length
  await window.evaluate(() => window.cove.remoteStop())
  await phone.waitFor((f) => remoteState(f)?.ended === 'stopped-at-mac', m3)
  expect(await world((w) => w.bannerUp)).toBe(false)
  expect(await world((w) => w.stopKeyHeld)).toBe(false)
  expect(
    await phone.ask('remote.input', { actions: [{ type: 'click', x: 0.5, y: 0.5 }] })
  ).toMatchObject({ ok: false })
  await new Promise((r) => setTimeout(r, 5500))
  expect(await phone.ask('remote.request')).toMatchObject({ ok: true, result: { state: 'asking' } })
  await expect.poll(() => world((w) => w.asks.length)).toBe(1)
  const m2 = phone.seen.length
  await world((_w, h) => h.answerAsk(false))
  await phone.waitFor((f) => remoteState(f)?.ended === 'denied', m2)
})

test('a session ends when the phone disconnects', async () => {
  await new Promise((r) => setTimeout(r, 5500))
  // Only strikes lock requests out, and that is two so far: stay under it.
  const code = await startSession()
  expect(await phone.ask('remote.code', { code })).toMatchObject({ ok: true })
  expect(await world((_w, h) => h.control.summary().active)).toBe(true)
  phone.ws.close()
  await expect
    .poll(() => world((_w, h) => h.control.summary().active), { timeout: 10_000 })
    .toBe(false)
  expect(await world((w) => w.bannerUp)).toBe(false)
  expect(await world((w) => w.stopKeyHeld)).toBe(false)
})

test('turning it off at the Mac ends a session and withdraws it from the phone', async () => {
  await connectPhone()
  await phone.until((f) => f.t === 'welcome')
  await new Promise((r) => setTimeout(r, 5500))
  const code = await startSession()
  expect(await phone.ask('remote.code', { code })).toMatchObject({ ok: true })
  const m4 = phone.seen.length
  await window.evaluate(() => window.cove.setRemoteShells(true))
  await window.evaluate(() => window.cove.setRemoteControl(false))
  await phone.waitFor((f) => remoteState(f)?.available === false, m4)
  // Terminals and scripting apps go off with it: the next time starts safe.
  expect(
    ((await window.evaluate(() => window.cove.remoteStatus())) as { shells: boolean }).shells
  ).toBe(false)
  expect(await world((_w, h) => h.control.summary().active)).toBe(false)
  expect(await world((w) => w.bannerUp)).toBe(false)
  expect(await phone.ask('remote.request')).toMatchObject({ ok: false })
})

test('the log has the sessions and the refusals, and none of what was typed', async () => {
  const log = readFileSync(join(userDataDir, 'memory.log'), 'utf8')
  expect(log).toMatch(/remote: switched on at the Mac/)
  expect(log).toMatch(/remote: session started for "Test iPhone"/)
  expect(log).toMatch(/remote: session ended \(stopped-at-mac\)/)
  expect(log).toMatch(/remote: session ended \(phone-left\)/)
  expect(log).toMatch(/remote: session ended \(turned-off\)/)
  expect(log).toMatch(/remote: refused (click|text|key) \((secret|own-window|blocked-key)\)/)
  expect(log).not.toMatch(/hunter2/)
  expect(log).not.toMatch(/hello 👋/)
})
