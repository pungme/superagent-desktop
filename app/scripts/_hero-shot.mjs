// Landing-page hero: a throwaway quiet instance (no window on screen), seeded
// with groups, projects, browser workspaces and a stored conversation (no live
// agent, no tokens), stripe.com opened in the chat's browser pane as desktop +
// iPhone through the agent's own MCP tools, then captured with the native panes
// composited in (as _shot-composite.mjs does).
//
//   npm run build && node scripts/_hero-shot.mjs <out.png> [width] [height]
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] || join(tmpdir(), 'hero.png'))
const W = Number(process.argv[3] || 1440)
const H = Number(process.argv[4] || 900)
const userData = mkdtempSync(join(tmpdir(), 'hero-data-'))
// The toolbar shows the project's full path: keep it short and plausible.
const root = '/tmp/Developer'
if (existsSync(root)) throw new Error(`${root} exists; not touching it`)
mkdirSync(root)
const urlFile = join(userData, 'mcp-url.txt')

const repo = (name) => {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'README.md'), `# ${name}\n`)
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'init')
  return d
}
const dirs = Object.fromEntries(
  ['landing-page', 'mobile-app', 'design-system', 'notes-app', 'reading-list'].map((n) => [n, repo(n)])
)

const app = await electron.launch({
  args: [join(here, '..', 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    COVE_E2E_QUIET: '1',
    COVE_USER_DATA: userData,
    COVE_E2E_MCP_URL_FILE: urlFile,
    NODE_ENV: 'production'
  }
})
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow, nativeTheme }, [w, h]) => {
    nativeTheme.themeSource = 'light'
    const bw = BrowserWindow.getAllWindows()[0]
    bw.setContentSize(w, h)
  }, [W, H])
  await win.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
    localStorage.setItem('cove.theme', 'light')
  })
  await win.reload()
  await win.waitForSelector('.sidebar', { timeout: 20_000 })

  const now = Date.now()
  const ids = await win.evaluate(
    async ({ dirs, now }) => {
      const cove = window.cove
      const gid = async (name) => {
        const tree = await cove.createGroup(name)
        return tree.find((g) => g.name === name).id
      }
      // A new group goes on top: made bottom first.
      const personal = await gid('Personal')
      const work = await gid('Work')
      const browse = await gid('Browse')
      for (const url of ['https://stripe.com/', 'https://vite.dev/guide/', 'http://localhost:5173/']) {
        const b = await cove.createBrowserWorkspace(browse, 'Browser project')
        await cove.updateWorkspace(b.workspaceId, { browserUrl: url })
      }
      const mk = async (g, n) => (await cove.createWorkspace(g, n, dirs[n])).workspaceId
      const landing = await mk(work, 'landing-page')
      await mk(work, 'mobile-app')
      await mk(work, 'design-system')
      await mk(personal, 'notes-app')
      await mk(personal, 'reading-list')

      const other = await cove.chatCreate(landing)
      await cove.chatUpdate(other, { title: 'Tighten the hero copy' })
      cove.chatSave(
        other,
        JSON.stringify([
          { kind: 'msg', msg: { id: 'o1', role: 'user', text: 'Make the headline shorter, keep the tone.', at: now - 3600e3 } },
          { kind: 'msg', msg: { id: 'o2', role: 'assistant', text: 'Two lines instead of three.', at: now - 3590e3 } }
        ])
      )
      const chat = await cove.chatCreate(landing)
      await cove.chatUpdate(chat, { title: 'Pricing page refresh' })
      // A chat that has talked works on its own branch, cut from its first message.
      const cwd = await cove.chatEnsureBranch(chat, dirs['landing-page'], 'pricing page refresh')
      if (cwd) await cove.chatUpdate(chat, { cwd })
      const t = now - 60e3
      cove.chatSave(
        chat,
        JSON.stringify([
          {
            kind: 'msg',
            msg: {
              id: 'u1',
              role: 'user',
              text: 'Open stripe.com and show it as desktop and iPhone side by side. Does the hero hold up on mobile?',
              at: t
            }
          },
          {
            kind: 'msg',
            msg: { id: 'a1', role: 'assistant', text: 'Opening it in the browser pane, both viewports, one session.', at: t + 4e3 }
          },
          { kind: 'tool', tool: { id: 't1', name: 'mcp__cove-browser__browser_navigate', detail: 'https://stripe.com' } },
          { kind: 'tool', tool: { id: 't2', name: 'mcp__cove-browser__browser_set_viewport', detail: 'both' } },
          { kind: 'tool', tool: { id: 't3', name: 'mcp__cove-browser__browser_screenshot', detail: '' } },
          {
            kind: 'msg',
            msg: {
              id: 'a2',
              role: 'assistant',
              text:
                'It holds up well. The gradient crops gracefully at 390px and the headline stays two lines. **Get started goes full width on the phone**, which reads deliberate, not squeezed.\n\n' +
                'One nitpick: the partner logo row collapses to two logos on mobile. If you want that pattern for our pricing page, we should plan the logo set around it.',
              at: t + 21e3,
              tokens: 61200,
              tokensNew: 2900
            }
          }
        ])
      )
      return { landing, chat }
    },
    { dirs, now }
  )
  await win.evaluate(([id, r]) => localStorage.setItem(`split:${id}`, r), [ids.landing, process.env.HERO_CHAT || '0.36'])
  await win.reload()
  await win.waitForSelector('.sidebar-item:has-text("landing-page")', { timeout: 20_000 })
  await win.click('.sidebar-item:has-text("landing-page")')
  await win.waitForTimeout(800)
  await win.screenshot({ path: out.replace(/\.png$/, '-step0.png') })
  if (process.env.HERO_STOP === '1') {
    console.log(await win.evaluate((id) => window.cove.chatList(id).then((l) => JSON.stringify(l.map((c) => [c.title, c.cwd])) ), ids.landing))
    console.log(await win.locator('.sidebar-item:has-text("landing-page")').first().evaluate((e) => e.outerHTML.slice(0, 3000)))
    console.log(await win.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('tree')).map((k) => k + '=' + localStorage.getItem(k))))
  }
  await win.click('.sidebar :text("Pricing page refresh")')
  await win.waitForTimeout(800)
  await win.screenshot({ path: out.replace(/\.png$/, '-step1.png') })
  console.log(JSON.stringify(ids))
  if (process.env.HERO_STOP === '1') process.exit(0)

  // The browser, opened the way the agent does it: over its MCP tools.
  for (let i = 0; i < 50 && !existsSync(urlFile); i++) await win.waitForTimeout(200)
  const mcpUrl = readFileSync(urlFile, 'utf8')
  const tool = async (name, args = {}) => {
    const res = await fetch(`${mcpUrl}?ws=${encodeURIComponent(ids.landing)}&chat=${encodeURIComponent(ids.chat)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    const text = await res.text()
    return text.slice(0, 300)
  }
  const btn = win.locator('.workspace-toolbar:visible .toolbar-btn:has-text("Browser")')
  if (await btn.count()) await btn.first().click()
  await win.waitForTimeout(1500)
  console.log(await tool('browser_navigate', { url: 'https://stripe.com/en-us' }))
  await win.waitForTimeout(1500)
  console.log(await tool('browser_set_viewport', { viewport: 'both' }))
  await win.waitForTimeout(9000)
  // A visitor who has already answered the cookie question and closed the
  // region and sales-chat prompts: hide what floats over the page.
  const tidy = `(() => {
    for (const b of document.querySelectorAll('button')) if (/^(Reject all|Alle ablehnen)$/i.test(b.textContent.trim())) b.click()
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if ((cs.position === 'fixed' || cs.position === 'sticky') && el.getBoundingClientRect().top > 80) el.style.setProperty('display', 'none', 'important')
    }
    scrollTo(0, 0)
  })()`
  for (let i = 0; i < 2; i++) {
    await app.evaluate(async ({ webContents }, js) => {
      for (const wc of webContents.getAllWebContents())
        if (/stripe\.com/.test(wc.getURL())) await wc.executeJavaScript(js).catch(() => {})
    }, tidy)
    await win.waitForTimeout(1500)
  }
  await win.screenshot({ path: out.replace(/\.png$/, '-step2.png') })
  await composite(win)
  await win.screenshot({ path: out })
  console.log('saved', out)
} finally {
  if (process.env.HERO_KEEP !== '1') {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}

// The panes are native views a CDP capture cannot see: capture each from main
// at its own bounds and lay the picture over that exact spot.
async function composite(win) {
  const views = await app.evaluate(async ({ BrowserWindow }) => {
    const bw = BrowserWindow.getAllWindows()[0]
    const out = []
    for (const v of bw.contentView.children) {
      if (!v.webContents || !v.getVisible?.()) continue
      const b = v.getBounds()
      if (b.width < 20 || b.height < 20) continue
      const img = await v.webContents.capturePage()
      if (img.isEmpty()) continue
      out.push({ ...b, url: v.webContents.getURL(), png: img.toPNG().toString('base64') })
    }
    return out
  })
  console.log('views', views.map((v) => `${v.url} ${v.x},${v.y} ${v.width}x${v.height}`))
  const res = await win.evaluate(
    ({ views, SIDEBAR_BG }) => {
      document.querySelectorAll('.__shot_overlay').forEach((n) => n.remove())
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      // The sidebar is native vibrancy over a transparent body: a CDP capture
      // sees through it. Stand in a neutral tone and the traffic lights.
      document.body.style.background = SIDEBAR_BG
      const lights = document.createElement('div')
      lights.className = '__shot_overlay'
      Object.assign(lights.style, { position: 'fixed', left: '20px', top: '14px', display: 'flex', gap: '8px', zIndex: '9999', pointerEvents: 'none' })
      for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
        const dot = document.createElement('span')
        Object.assign(dot.style, { width: '12px', height: '12px', borderRadius: '50%', background: color, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.12)' })
        lights.appendChild(dot)
      }
      document.body.appendChild(lights)
      // Inside the pane's host, not fixed over the window (a full-window layer
      // repaints the whole surface and the material comes out black).
      const host = [...document.querySelectorAll('.browser-host')].find((h) => h.offsetParent !== null)
      const hr = host.getBoundingClientRect()
      const frames = [...host.querySelectorAll('.browser-sim-frame')].filter((f) => f.offsetParent !== null)
      for (const v of views) {
        // The frame this view sits in gives the corners it is drawn with.
        const f = frames.find((fr) => {
          const r = fr.getBoundingClientRect()
          return v.x >= r.left - 2 && v.x + v.width <= r.right + 2 && v.y >= r.top - 2 && v.y + v.height <= r.bottom + 2
        })
        const radius = f ? getComputedStyle(f).borderRadius : '0'
        const clip = document.createElement('div')
        clip.className = '__shot_overlay'
        Object.assign(clip.style, { position: 'absolute', left: `${v.x - hr.left}px`, top: `${v.y - hr.top}px`, width: `${v.width}px`, height: `${v.height}px`, overflow: 'hidden', borderRadius: v.radius ?? radius, pointerEvents: 'none', zIndex: '5' })
        const img = document.createElement('img')
        img.src = `data:image/png;base64,${v.png}`
        Object.assign(img.style, { display: 'block', width: '100%', height: '100%' })
        clip.appendChild(img)
        host.appendChild(clip)
      }
      return frames.map((f) => { const r = f.getBoundingClientRect(); return `${f.className} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} r=${getComputedStyle(f).borderRadius}` })
    },
    { views, SIDEBAR_BG: process.env.HERO_SIDEBAR || '#ececee' }
  )
  console.log(res)
  await win.waitForFunction(() => [...document.querySelectorAll('.__shot_overlay img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 }).catch(() => console.error('overlay did not decode'))
  await win.waitForTimeout(400)
}
