import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'
import WebSocket from 'ws'
import { build } from 'esbuild'
import { deriveKeys, aadFor, Sealer, Opener } from '../src/main/companion/crypto'
import type { PairPayload, ServerFrame } from '../src/shared/companion-protocol'

/**
 * The phone using the Mac's browser pane (`browser.input`), against the real
 * app, a real relay and a real page: a fake phone pairs, opens a page in a
 * conversation the Mac is not showing, then taps, hovers, right-clicks,
 * types, presses Return and scrolls. The page reports what it heard to the
 * test's own server, so nothing here drives the pane any other way.
 *
 * Needs the relay repo beside this one (as the companion suite does); skips
 * itself without it.
 */

const relayDir = join(__dirname, '..', '..', '..', 'superagent-relay')
const hasRelay = existsSync(join(relayDir, 'src', 'node.ts'))

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let relay: { close: () => void; address: () => AddressInfo | string | null } | null = null
let site: Server
let siteUrl: string
let chatId: string
const heard: Record<string, unknown>[] = []

const page = `<!doctype html><meta charset="utf-8"><title>Phone input</title>
<style>
  body{margin:0;height:6000px;font:14px system-ui;background:linear-gradient(#fff,#ccd)}
  .f{position:fixed}
</style>
<button id="b" class="f" style="left:40%;top:20%;width:140px;height:44px">Tap me</button>
<div id="hov" class="f" style="left:70%;top:8%;width:80px;height:80px;background:#9cf"></div>
<form id="form" class="f" style="left:8%;top:45%">
  <input id="t" style="width:220px;height:30px" autocomplete="off">
</form>
<script>
  const log = (o) => fetch('/log', { method: 'POST', body: JSON.stringify(o) });
  const at = (id) => { const r = document.getElementById(id).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
  addEventListener('load', () => log({ kind: 'layout', w: innerWidth, h: innerHeight,
    b: at('b'), t: at('t'), hov: at('hov') }));
  const b = document.getElementById('b'), t = document.getElementById('t');
  b.addEventListener('click', (e) => log({ kind: 'click', x: e.clientX, y: e.clientY, trusted: e.isTrusted }));
  b.addEventListener('dblclick', () => log({ kind: 'dblclick' }));
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); log({ kind: 'contextmenu', button: e.button }) });
  document.getElementById('hov').addEventListener('mouseenter', () => log({ kind: 'hover' }));
  t.addEventListener('input', () => log({ kind: 'input', value: t.value }));
  t.addEventListener('select', () => log({ kind: 'select', text: t.value.slice(t.selectionStart, t.selectionEnd) }));
  document.getElementById('form').addEventListener('submit', (e) => { e.preventDefault(); log({ kind: 'submit', value: t.value }) });
  let st; addEventListener('scroll', () => { clearTimeout(st); st = setTimeout(() => log({ kind: 'scroll', y: scrollY }), 150) });
</script>`

/** A phone, as the Mac sees one. */
class FakePhone {
  ws!: WebSocket
  sealer: Sealer
  opener: Opener
  inbox: ServerFrame[] = []
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
  async until(pred: (f: ServerFrame) => boolean): Promise<ServerFrame> {
    for (;;) {
      const f = await this.next()
      if (pred(f)) return f
    }
  }
  private n = 0
  async ask(
    method: string,
    params: unknown
  ): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
    const id = `r${++this.n}`
    this.send({ t: 'req', id, method, params })
    return (await this.until(
      (f) => f.t === 'res' && (f as { id?: string }).id === id
    )) as unknown as { ok: boolean; result?: unknown; error?: unknown }
  }
}

let phone: FakePhone
const heardOf = (kind: string): Record<string, unknown>[] => heard.filter((h) => h.kind === kind)
const input = (action: Record<string, unknown>): ReturnType<FakePhone['ask']> =>
  phone.ask('browser.input', { chatId, action })

test.describe.configure({ mode: 'serial' })
test.skip(!hasRelay, 'needs the relay repo beside this one')

test.beforeAll(async () => {
  // The relay is source in another repo with no node_modules of its own:
  // bundle it against this one's `ws`.
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
  const { startRelay } = require(out) as {
    startRelay: (port: number) => NonNullable<typeof relay>
  }
  relay = startRelay(0)
  await new Promise((r) => setTimeout(r, 100))
  const relayPort = (relay.address() as AddressInfo).port

  site = createServer((req, res) => {
    if (req.url === '/log') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        heard.push(JSON.parse(body))
        res.end('ok')
      })
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(page)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`

  userDataDir = mkdtempSync(join(tmpdir(), 'cove-phone-input-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-phone-input-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
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
  chatId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return window.cove.chatCreate(ws.id)
  })

  // Pair, as the phone does from the QR, and accept on the Mac.
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
  // The Mac asks; answer it the way its sheet would.
  await new Promise((r) => setTimeout(r, 300))
  await window.evaluate(() => window.cove.companionPairDecide(true))
  const paired = (await pairing.until((f) => f.t === 'paired')) as { token: string }
  pairing.ws.close()

  phone = new FakePhone(url, secret, payload.m)
  await phone.connect()
  phone.send({ t: 'hello', v: 1, device: 'iphone-e2e', token: paired.token, app: 'ios/e2e' })
  await phone.until((f) => f.t === 'welcome')
})

test.afterAll(async () => {
  phone?.ws.close()
  await app?.close()
  relay?.close()
  site?.close()
  for (const d of [userDataDir, projectDir]) if (d) rmSync(d, { recursive: true, force: true })
})

/** A point on the phone's picture: the page's own point over the page's size. */
const frac = (
  p: { x: number; y: number },
  l: { w: number; h: number }
): { x: number; y: number } => ({
  x: p.x / l.w,
  y: p.y / l.h
})

test('the phone taps, hovers, right-clicks, types and scrolls a page the Mac is not showing', async () => {
  // Nothing open yet: refused.
  expect(await input({ type: 'click', x: 0.5, y: 0.5 })).toMatchObject({ ok: false })

  // Opened from the phone: the conversation is not on the Mac's screen, so
  // this is the live-but-hidden pane, which paints only while it is used.
  expect(await phone.ask('browser.open', { chatId, url: siteUrl })).toMatchObject({ ok: true })
  await expect.poll(() => heardOf('layout').length, { timeout: 15_000 }).toBeGreaterThan(0)
  const layout = heardOf('layout').at(-1) as {
    w: number
    h: number
    b: { x: number; y: number }
    t: { x: number; y: number }
    hov: { x: number; y: number }
  }

  // Hover: the pointer alone, no button.
  expect(await input({ type: 'move', ...frac(layout.hov, layout) })).toMatchObject({ ok: true })
  await expect.poll(() => heardOf('hover').length).toBe(1)

  // A tap lands on the button, where the phone put it, as a real click.
  const tap = frac(layout.b, layout)
  expect(await input({ type: 'click', ...tap })).toMatchObject({ ok: true })
  await expect.poll(() => heardOf('click').length).toBe(1)
  const click = heardOf('click')[0] as { x: number; y: number; trusted: boolean }
  expect(Math.abs(click.x - layout.b.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(click.y - layout.b.y)).toBeLessThanOrEqual(2)
  expect(click.trusted).toBe(true)

  // A double tap: the second press says it is the second.
  expect(await input({ type: 'click', ...tap, count: 2 })).toMatchObject({ ok: true })
  await expect.poll(() => heardOf('dblclick').length).toBe(1)

  // The trackpad's two-finger tap: a right-click the page sees.
  expect(await input({ type: 'click', ...tap, button: 'right' })).toMatchObject({ ok: true })
  await expect.poll(() => heardOf('contextmenu').length).toBe(1)
  expect(heardOf('contextmenu')[0].button).toBe(2)

  // Into the field, type, fix a letter, and submit with Return.
  expect(await input({ type: 'click', ...frac(layout.t, layout) })).toMatchObject({ ok: true })
  expect(await input({ type: 'text', text: 'héllo wörld!' })).toMatchObject({ ok: true })
  expect(await input({ type: 'key', key: 'Backspace' })).toMatchObject({ ok: true })
  await expect
    .poll(() => (heardOf('input').at(-1) as { value?: string })?.value)
    .toBe('héllo wörld')
  expect(await input({ type: 'key', key: 'Enter' })).toMatchObject({ ok: true })
  await expect.poll(() => heardOf('submit').length).toBe(1)
  expect(heardOf('submit')[0].value).toBe('héllo wörld')

  // The trackpad's tap-and-drag: press at the field's left, drag across, let go.
  const left = { x: (layout.t.x - 105) / layout.w, y: layout.t.y / layout.h }
  const right = { x: (layout.t.x + 105) / layout.w, y: layout.t.y / layout.h }
  expect(await input({ type: 'down', ...left })).toMatchObject({ ok: true })
  for (let i = 1; i <= 6; i++)
    await input({ type: 'move', x: left.x + ((right.x - left.x) * i) / 6, y: left.y })
  expect(await input({ type: 'up', ...right })).toMatchObject({ ok: true })
  // From about the first letter to the end: the exact first letter depends on the font.
  await expect
    .poll(() => (heardOf('select').at(-1) as { text?: string })?.text ?? '')
    .toMatch(/llo wörld$/)

  // A finger pulled up a quarter of the picture: the page goes down a quarter.
  expect(await input({ type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.25 })).toMatchObject({
    ok: true
  })
  await expect.poll(() => (heardOf('scroll').at(-1) as { y?: number })?.y ?? 0).toBeGreaterThan(0)
  const down = (heardOf('scroll').at(-1) as { y: number }).y
  expect(Math.abs(down - layout.h * 0.25)).toBeLessThanOrEqual(layout.h * 0.05)
  // And back the other way.
  expect(await input({ type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.25 })).toMatchObject({
    ok: true
  })
  await expect.poll(() => (heardOf('scroll').at(-1) as { y?: number })?.y).toBe(0)

  // The picture keeps coming while it is being used.
  const shot = await phone.ask('browser.screenshot', { chatId })
  expect(shot).toMatchObject({ ok: true })
  expect((shot.result as { jpeg: string }).jpeg.length).toBeGreaterThan(100)

  // Nothing for a chat that does not exist, nor a point off the picture.
  expect(
    await phone.ask('browser.input', { chatId: 'nope', action: { type: 'click', x: 0.5, y: 0.5 } })
  ).toMatchObject({ ok: false })
  expect(await input({ type: 'click', x: 2, y: 0.5 })).toMatchObject({ ok: false })
  expect(heardOf('click').length).toBe(2)
})
