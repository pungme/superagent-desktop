import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'

/**
 * The agent's browser tools, called the way Claude Code calls them (over MCP),
 * against a page that has the things they used to trip on: fields known only
 * by their label, a native select, a hidden file input, JavaScript dialogs,
 * iframes on this origin and another, a web component, a page far longer than
 * one read, a menu that opens on hover, things to drag.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let mcpUrl: string
let wsId: string
let chatId: string
let site: Server
let other: Server
let siteUrl: string
let otherUrl: string

const LONG = Array.from({ length: 900 }, (_, i) => `Paragraph ${i} of the long page.`).join(' ')

const page = (): string => `<!doctype html><meta charset="utf-8"><title>Fixture</title>
<style>
  body{font:14px system-ui;margin:16px} .menu .items{display:none} .menu:hover .items{display:block}
  #track{width:300px;height:20px;background:#ddd;position:relative} #knob{width:20px;height:20px;background:#333;position:absolute;left:0}
  .col{display:inline-block;vertical-align:top;width:140px;min-height:60px;border:1px solid #999;margin-right:8px;padding:4px}
  #box{height:80px;overflow:auto;border:1px solid #999;width:240px}
</style>
<form id="f" onsubmit="event.preventDefault()">
  <label for="em">Email address</label> <input id="em" name="email" type="email" required value="old@example.com">
  <label>Full name <input name="fullname" placeholder="Jane Doe"></label>
  <span id="pwl">Secret phrase</span> <input aria-labelledby="pwl" name="pw" type="password" value="hunter2">
  <label><input type="checkbox" name="news" checked> Send me news</label>
  <label><input type="radio" name="plan" value="free" checked> Free</label>
  <label><input type="radio" name="plan" value="pro"> Pro</label>
  <label for="co">Country</label>
  <select id="co" name="country" onchange="document.getElementById('picked').textContent='country:'+this.value">
    <option value="">Choose…</option><option value="de">Germany</option><option value="th">Thailand</option><option value="us" disabled>United States</option>
  </select>
  <label for="tags">Tags</label>
  <select id="tags" name="tags" multiple><option>red</option><option>green</option><option>blue</option></select>
  <input name="locked" aria-label="Account id" value="A-1" disabled>
  <span id="picked"></span>
</form>
<button onclick="document.getElementById('up').click()">Attach a file</button>
<input id="up" type="file" name="doc" accept=".txt" style="display:none"
  onchange="this.files[0].text().then(t => document.getElementById('upout').textContent = 'uploaded:' + this.files[0].name + ':' + t.trim())">
<span id="upout"></span>
<p>
  <button onclick="alert('Saved!'); document.getElementById('dlg').textContent='alert done'">Show alert</button>
  <button onclick="document.getElementById('dlg').textContent='confirm:' + confirm('Delete the project?')">Ask to delete</button>
  <button onclick="document.getElementById('dlg').textContent='prompt:' + prompt('New name?', 'untitled')">Ask a name</button>
  <span id="dlg"></span>
</p>
<div class="menu" onmouseenter="document.getElementById('hov').textContent='hovered'">
  <button type="button">Account menu</button>
  <div class="items"><a href="#signout" onclick="document.getElementById('hov').textContent='signed out'">Sign out</a></div>
</div>
<span id="hov"></span>
<div id="track"><div id="knob" role="slider" aria-label="Volume"></div></div><span id="vol">vol:0</span>
<script>
  (() => {
    const knob = document.getElementById('knob'); let on = false;
    knob.addEventListener('pointerdown', () => { on = true });
    addEventListener('pointermove', (e) => { if (!on) return;
      const x = Math.max(0, Math.min(280, e.clientX - document.getElementById('track').getBoundingClientRect().left - 10));
      knob.style.left = x + 'px'; document.getElementById('vol').textContent = 'vol:' + Math.round(x / 2.8) });
    addEventListener('pointerup', () => { on = false });
  })()
</script>
<div>
  <div class="col" id="todo"><a href="#card" id="card" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','card')">Card to move</a></div>
  <div class="col" id="done" role="button" aria-label="Done column" ondragover="event.preventDefault()"
    ondrop="event.preventDefault(); this.appendChild(document.getElementById(event.dataTransfer.getData('text/plain'))); document.getElementById('dnd').textContent='dropped in done'"></div>
  <span id="dnd"></span>
</div>
<my-widget></my-widget><span id="wc"></span>
<script>
  customElements.define('my-widget', class extends HTMLElement {
    connectedCallback() {
      const r = this.attachShadow({ mode: 'open' });
      r.innerHTML = '<p>Inside the component</p><label>Widget code <input name="code"></label><button>Widget button</button>';
      r.querySelector('button').onclick = () => { document.getElementById('wc').textContent = 'widget:' + r.querySelector('input').value };
    }
  })
</script>
<iframe src="/inner" title="same" style="width:320px;height:90px"></iframe>
<iframe src="${otherUrl}pay" title="pay" style="width:320px;height:110px"></iframe>
<span id="paid"></span>
<script>addEventListener('message', (e) => { document.getElementById('paid').textContent = 'paid:' + e.data })</script>
<div id="box">${Array.from({ length: 40 }, (_, i) => `<div>row ${i}</div>`).join('')}<button onclick="document.getElementById('boxout').textContent='box end'">End of the box</button></div>
<span id="boxout"></span>
<p id="long">${LONG}</p>
<button onclick="document.getElementById('foot').textContent='footer clicked'">Footer button</button><span id="foot"></span>`

const inner = `<!doctype html><title>Inner</title><body style="margin:4px;font:13px system-ui">
<p>Inner frame words</p><label>Coupon <input name="coupon"></label>
<button onclick="parent.document.getElementById('paid').textContent='coupon:' + document.querySelector('input').value">Apply coupon</button>`

const pay = `<!doctype html><title>Pay</title><body style="margin:4px;font:13px system-ui">
<p>Card details</p><label>Card number <input name="card"></label>
<select aria-label="Expiry year"><option>2026</option><option>2027</option><option>2028</option></select>
<button onclick="parent.postMessage(document.querySelector('input').value + '/' + document.querySelector('select').value, '*')">Pay now</button>`

const leave = `<!doctype html><title>Leaving</title><input aria-label="Draft"><a href="/">Home</a>
<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'unsaved' })</script>`

/** Call one of the agent's tools, the way Claude Code does over HTTP. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(
    `${mcpUrl}?ws=${encodeURIComponent(wsId)}&chat=${encodeURIComponent(chatId)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    }
  )
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6)
  const msg = JSON.parse(json) as {
    result?: { isError?: boolean; content: { text?: string; data?: string }[] }
    error?: { message: string }
  }
  if (msg.error) throw new Error(msg.error.message)
  const out = msg.result!.content.map((c) => c.text ?? c.data ?? '').join('\n')
  if (msg.result!.isError) throw new Error(out)
  return out
}

interface El {
  index: number
  tag: string
  label?: string
  text?: string
  name?: string
  value?: string
  type?: string
  frame?: string
  checked?: boolean
  disabled?: boolean
  required?: boolean
  options?: string[]
  placeholder?: string
}
interface Read {
  url: string
  title: string
  text: string
  textMore?: string
  elements: El[]
  fileInputs?: { input: number; name?: string; accept?: string; hidden?: boolean }[]
  frames?: { frame: string; text?: string }[]
  dialogs?: string[]
}
async function read(args: Record<string, unknown> = {}): Promise<Read> {
  const out = await tool('browser_read_page', args)
  return JSON.parse(/<untrusted-web-content>\n([\s\S]*)\n<\/untrusted-web-content>/.exec(out)![1])
}
const js = async (expression: string): Promise<unknown> =>
  JSON.parse((await tool('browser_evaluate', { expression })).split('\n')[0])
const text = (id: string): Promise<unknown> =>
  js(`document.getElementById(${JSON.stringify(id)}).textContent`)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-btools-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-btools-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e\n')
  writeFileSync(join(projectDir, 'notes.txt'), 'hello from disk\n')
  // Another origin (a different port is one) for the frame a page cannot see into.
  other = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(pay)
  })
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()))
  otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/`
  site = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(req.url === '/inner' ? inner : req.url === '/leave' ? leave : page())
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`

  const urlFile = join(userDataDir, 'mcp-url.txt')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      COVE_E2E_MCP_URL_FILE: urlFile,
      NODE_ENV: 'production'
    }
  })
  // Playwright dismisses any dialog nobody is listening for, on every page of
  // the app it can see — the pane's included. The app answers them itself, and
  // that is what is under test: say we are listening, and leave them be.
  const leaveDialogs = (p: Page): void => void p.on('dialog', () => {})
  app.context().on('page', leaveDialogs)
  app.on('window', leaveDialogs)
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  leaveDialogs(window)
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
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return { wsId: ws.id, chatId: await window.cove.chatCreate(ws.id) }
  })
  wsId = made.wsId
  chatId = made.chatId
  await window.click('.sidebar-item:has-text("e2e-project")')
  // On screen and sized, as it is when a person has the browser open.
  await window.click('.workspace-toolbar:visible .toolbar-btn:has-text("Browser")')
  await expect(window.locator('.browser-address:visible')).toBeVisible({ timeout: 10_000 })
  expect(await tool('browser_navigate', { url: siteUrl })).toContain('Now at')
  await expect.poll(() => js('window.innerWidth > 200')).toBe(true)
})

test.afterAll(async () => {
  await app?.close()
  site?.close()
  other?.close()
  for (const d of [userDataDir, projectDir]) rmSync(d, { recursive: true, force: true })
})

test('a field is read with its label, its name, what it holds and its state', async () => {
  const { elements } = await read()
  const by = (name: string): El => elements.find((e) => e.name === name)!
  expect(by('email')).toMatchObject({
    label: 'Email address',
    type: 'email',
    value: 'old@example.com',
    required: true
  })
  // A label wrapped round the input, and one pointed at by aria-labelledby.
  expect(by('fullname')).toMatchObject({ label: 'Full name', placeholder: 'Jane Doe' })
  expect(by('pw').label).toBe('Secret phrase')
  // A password says it is filled, never with what.
  expect(by('pw').value).toBe('(7 characters, hidden)')
  expect(JSON.stringify(elements)).not.toContain('hunter2')
  expect(by('news')).toMatchObject({ label: 'Send me news', checked: true })
  const plans = elements.filter((e) => e.name === 'plan')
  expect(plans.map((p) => [p.label, p.value, p.checked])).toEqual([
    ['Free', 'free', true],
    ['Pro', 'pro', false]
  ])
  expect(by('country')).toMatchObject({
    label: 'Country',
    value: 'Choose…',
    options: ['Choose…', 'Germany', 'Thailand', 'United States']
  })
  expect(by('locked')).toMatchObject({ label: 'Account id', value: 'A-1', disabled: true })
})

test('a native select is set by the option it shows, and says what else there is', async () => {
  expect(await tool('browser_select_option', { text: 'Country', option: 'Thailand' })).toContain(
    'selected Thailand'
  )
  // The page heard it, as it would a person choosing.
  expect(await text('picked')).toBe('country:th')
  const { elements } = await read()
  const country = elements.find((e) => e.name === 'country')!
  expect(country.value).toBe('Thailand')
  // By number, and several at once in a multiple select.
  const tags = elements.find((e) => e.name === 'tags')!
  await tool('browser_select_option', { index: tags.index, options: ['red', 'blue'] })
  expect(
    await js("[...document.getElementById('tags').selectedOptions].map(o => o.value)")
  ).toEqual(['red', 'blue'])
  await expect(
    tool('browser_select_option', { index: country.index, option: 'Narnia' })
  ).rejects.toThrow(/No option matching "Narnia".*Germany \| Thailand/s)
  await expect(
    tool('browser_select_option', { index: country.index, option: 'United States' })
  ).rejects.toThrow(/disabled/)
  // Something that is not a select says what to do instead.
  await expect(tool('browser_select_option', { text: 'Show alert', option: 'x' })).rejects.toThrow(
    /not a native select/
  )
})

test('a file goes into the hidden input behind an Attach button', async () => {
  const { fileInputs } = await read()
  expect(fileInputs).toEqual([{ input: 0, name: 'doc', accept: '.txt', hidden: true }])
  const file = join(projectDir, 'notes.txt')
  expect(await tool('browser_upload_file', { paths: [file] })).toContain('attached notes.txt')
  await expect.poll(() => text('upout')).toBe('uploaded:notes.txt:hello from disk')
  await expect(tool('browser_upload_file', { paths: ['notes.txt'] })).rejects.toThrow(/full path/)
  await expect(
    tool('browser_upload_file', { paths: [join(projectDir, 'missing.txt')] })
  ).rejects.toThrow(/No such file/)
  await expect(tool('browser_upload_file', { paths: [file, file] })).rejects.toThrow(/one file/)
  await expect(tool('browser_upload_file', { paths: [file], input: 4 })).rejects.toThrow(
    /no file input 4/
  )
})

test('dialogs are answered and reported: an alert is acknowledged, a question is Cancel unless told', async () => {
  const alert = await tool('browser_click', { text: 'Show alert' })
  expect(alert).toContain('showed an alert: "Saved!" — acknowledged')
  expect(await text('dlg')).toBe('alert done')

  // Unasked, a question is answered Cancel, and the agent is told how to say OK.
  const refused = await tool('browser_click', { text: 'Ask to delete' })
  expect(refused).toContain('a confirm dialog: "Delete the project?" — answered Cancel')
  expect(refused).toContain('browser_dialog')
  expect(await text('dlg')).toBe('confirm:false')

  expect(await tool('browser_dialog', { accept: true })).toContain('answered OK')
  expect(await tool('browser_click', { text: 'Ask to delete' })).toContain('answered OK')
  expect(await text('dlg')).toBe('confirm:true')
  // One dialog's worth: the next is back to Cancel.
  await tool('browser_click', { text: 'Ask to delete' })
  expect(await text('dlg')).toBe('confirm:false')

  await tool('browser_dialog', { accept: true, text: 'Q3 report' })
  expect(await tool('browser_click', { text: 'Ask a name' })).toContain('answered "Q3 report"')
  expect(await text('dlg')).toBe('prompt:Q3 report')
  await tool('browser_click', { text: 'Ask a name' })
  expect(await text('dlg')).toBe('prompt:null')
})

test('an iframe on the same origin and a web component are read and driven like the page', async () => {
  const r = await read()
  const coupon = r.elements.find((e) => e.name === 'coupon')!
  expect(coupon).toMatchObject({ label: 'Coupon', frame: 'iframe' })
  await tool('browser_click', { index: coupon.index })
  await tool('browser_type', { text: 'SAVE10' })
  await tool('browser_click', { text: 'Apply coupon' })
  expect(await text('paid')).toBe('coupon:SAVE10')

  const code = r.elements.find((e) => e.name === 'code')!
  expect(code).toMatchObject({ label: 'Widget code', frame: 'web component' })
  await tool('browser_click', { index: code.index })
  await tool('browser_type', { text: 'W-7' })
  await tool('browser_click', { text: 'Widget button' })
  expect(await text('wc')).toBe('widget:W-7')
})

test('an iframe from another site is read and driven too', async () => {
  const r = await read()
  const frame = r.frames!.find((f) => f.frame.startsWith('iframe 127.0.0.1'))!
  expect(frame.text).toContain('Card details')
  const card = r.elements.find((e) => e.name === 'card')!
  expect(card.label).toBe('Card number')
  expect(card.frame).toMatch(/^iframe 127\.0\.0\.1/)
  await tool('browser_click', { index: card.index })
  await tool('browser_type', { text: '4242' })
  const year = r.elements.find((e) => e.label === 'Expiry year')!
  await tool('browser_select_option', { index: year.index, option: '2028' })
  // By its words alone: looked for in the page first, then in each frame.
  await tool('browser_click', { text: 'Pay now' })
  await expect.poll(() => text('paid')).toBe('paid:4242/2028')
})

test('a long page is read on from where the last read stopped, and scrolled', async () => {
  const first = await read()
  expect(first.text.length).toBe(12000)
  const offset = Number(/textOffset (\d+)/.exec(first.textMore!)![1])
  expect(offset).toBe(12000)
  const next = await read({ textOffset: offset })
  expect(next.text.slice(0, 40)).not.toBe(first.text.slice(0, 40))
  expect(first.text.endsWith(next.text.slice(0, 1))).toBe(false)
  // Read to the end, the last paragraph is there.
  let all = first.text + next.text
  for (let r = next; r.textMore;) {
    r = await read({ textOffset: Number(/textOffset (\d+)/.exec(r.textMore)![1]) })
    all += r.text
  }
  expect(all).toContain('Paragraph 899 of the long page.')
  // And after the page's own words, those innerText leaves out: what is inside
  // the web component and the iframe on this origin.
  expect(all).toContain('Inside the component')
  expect(all).toContain('Inner frame words')

  expect(await tool('browser_scroll', { direction: 'bottom' })).toContain('(the bottom)')
  expect(await js('scrollY > 500')).toBe(true)
  await tool('browser_click', { text: 'Footer button' })
  expect(await text('foot')).toBe('footer clicked')
  expect(await tool('browser_scroll', { direction: 'top' })).toContain('(the top)')
  expect(await js('scrollY')).toBe(0)
  const down = await tool('browser_scroll')
  expect(Number(/scrolled to (\d+)/.exec(down)![1])).toBeGreaterThan(200)
  // A box with its own scrollbar is scrolled itself, not the page round it.
  await tool('browser_scroll', { direction: 'top' })
  const before = await js('scrollY')
  await tool('browser_scroll', { text: 'End of the box', direction: 'bottom' })
  expect(await js("document.getElementById('box').scrollTop > 100")).toBe(true)
  expect(Math.abs(Number(await js('scrollY')) - Number(before))).toBeLessThan(400)
  await tool('browser_click', { text: 'End of the box' })
  expect(await text('boxout')).toBe('box end')
})

test('hover opens a menu, and a drag moves a slider and a card', async () => {
  await tool('browser_scroll', { direction: 'top' })
  expect(await text('hov')).toBe('')
  await tool('browser_hover', { text: 'Account menu' })
  expect(await text('hov')).toBe('hovered')
  // The item only exists to the pointer while the menu is hovered.
  await tool('browser_click', { text: 'Sign out' })
  expect(await text('hov')).toBe('signed out')

  // A slider: pointer events, dragged to a point further along its track.
  const r = await read()
  const knob = r.elements.find((e) => e.label === 'Volume')!
  const at = (await js(
    "(() => { const t = document.getElementById('track').getBoundingClientRect(); return [t.left + 210, t.top + 10] })()"
  )) as number[]
  const dpr = Number(await js('devicePixelRatio'))
  await tool('browser_drag', { fromIndex: knob.index, toX: at[0] * dpr, toY: at[1] * dpr })
  const vol = Number(String(await text('vol')).split(':')[1])
  expect(vol).toBeGreaterThan(55)
  expect(vol).toBeLessThan(85)

  // A draggable element: the browser's own drag-and-drop.
  await tool('browser_drag', { fromText: 'Card to move', toText: 'Done column' })
  expect(await text('dnd')).toBe('dropped in done')
  expect(await js("document.getElementById('card').parentElement.id")).toBe('done')
})

test('back, forward and reload, and a page that asks before it lets go', async () => {
  await tool('browser_navigate', { url: `${siteUrl}leave` })
  expect(await js('document.title')).toBe('Leaving')
  // Touched, so the page's "leave?" really fires.
  await tool('browser_click', { text: 'Draft' })
  await tool('browser_type', { text: 'x' })
  const back = await tool('browser_back')
  expect(back).toContain(`Now at ${siteUrl}`)
  expect(await js('document.title')).toBe('Fixture')
  expect(await tool('browser_forward')).toContain('leave')
  expect(await js('document.title')).toBe('Leaving')
  await tool('browser_evaluate', { expression: "document.title = 'changed'" })
  await tool('browser_click', { text: 'Draft' })
  await tool('browser_type', { text: 'y' })
  await tool('browser_reload')
  expect(await js('document.title')).toBe('Leaving')
})
