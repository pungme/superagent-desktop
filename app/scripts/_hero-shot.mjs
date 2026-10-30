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
// HERO_VIDEO=<dir>: film the story into numbered frames there instead (see story()).
const VIDEO = process.env.HERO_VIDEO ? resolve(process.env.HERO_VIDEO) : null

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
    // Exposes the store (window.__store), which is how the split is made below.
    localStorage.setItem('cove.e2e', '1')
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
      const mobile = await mk(work, 'mobile-app')
      const design = await mk(work, 'design-system')
      const notes = await mk(personal, 'notes-app')
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
      // The split scene's four conversations, each in a different project,
      // stored finished: the film reveals them a step at a time.
      const tool = (id, name, detail) => ({ kind: 'tool', tool: { id, name, detail } })
      const said = async (ws, title, ask, tools, answer, existing) => {
        const id = existing ?? (await cove.chatCreate(ws))
        await cove.chatUpdate(id, { title })
        cove.chatSave(
          id,
          JSON.stringify([
            { kind: 'msg', msg: { id: id + 'u', role: 'user', text: ask, at: now - 90e3 } },
            ...tools.map(([n, d], i) => tool(id + 't' + i, n, d)),
            { kind: 'msg', msg: { id: id + 'a', role: 'assistant', text: answer, at: now - 5e3, tokens: 48000, tokensNew: 2100 } }
          ])
        )
        return id
      }
      const split = [
        await said(landing, 'Tighten the hero copy', 'Make the headline shorter, keep the tone.',
          [['Read', 'src/Hero.tsx'], ['Edit', 'src/Hero.tsx'], ['Bash', 'npm run build']],
          'Two lines instead of three. I cut "for teams of any size": it was doing nothing, and the sentence lands harder without it.', other),
        await said(mobile, 'Fix the flaky login test', 'The login e2e fails about one run in five. Find out why.',
          [['Bash', 'npx playwright test login'], ['Read', 'e2e/login.spec.ts'], ['Grep', 'waitForURL'], ['Edit', 'e2e/login.spec.ts'], ['Bash', 'npx playwright test login --repeat-each 30']],
          'It races the session cookie: the test taps before the redirect lands. It now waits for the URL, and 30 runs in a row are green.'),
        await said(design, 'Dark mode tokens', 'Add dark variants for the surface and border tokens.',
          [['Read', 'tokens/color.json'], ['Edit', 'tokens/color.json'], ['Edit', 'tokens/dark.json'], ['Bash', 'npm run build:tokens']],
          'Added dark surface, border and both hover states. Every pair passes AA contrast, and the token build is clean.'),
        await said(notes, 'Export to Markdown', 'Add Export as Markdown to the File menu.',
          [['Grep', 'File menu'], ['Read', 'src/menu.ts'], ['Edit', 'src/menu.ts'], ['Edit', 'src/export.ts'], ['Bash', 'npm test']],
          'File › Export as Markdown is in, on ⇧⌘E. Headings, lists and checkboxes round-trip, and images are saved beside the file.')
      ]
      return { landing, chat, split: [[landing, split[0]], [mobile, split[1]], [design, split[2]], [notes, split[3]]] }
    },
    { dirs, now }
  )
  await win.evaluate(([id, r]) => localStorage.setItem(`split:${id}`, r), [ids.landing, process.env.HERO_CHAT || '0.36'])
  await win.reload()
  await win.waitForSelector('.sidebar-item:has-text("landing-page")', { timeout: 20_000 })
  await win.click('.sidebar-item:has-text("landing-page")')
  await win.waitForTimeout(800)
  await win.click('.sidebar :text("Pricing page refresh")')
  await win.waitForTimeout(800)
  console.log(JSON.stringify(ids))
  const film = VIDEO ? await story(win) : null
  if (film) {
    await composite(win)
    await film.scene0()
  }

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
  if (film) {
    await win.waitForTimeout(7000)
    await tidyPages()
    await composite(win)
    await film.scene1()
  }
  await win.waitForTimeout(1500)
  console.log(await tool('browser_set_viewport', { viewport: 'both' }))
  await win.waitForTimeout(9000)
  await tidyPages()
  await composite(win)
  if (film) {
    await film.scene2()
    await film.sceneSplit(ids.split)
    await film.scenePalette('login')
    await film.finale()
  }
  else await win.screenshot({ path: out })
  console.log('saved', out)
} finally {
  if (process.env.HERO_KEEP !== '1') {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}

async function tidyPages() {
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
    await new Promise((r) => setTimeout(r, 1500))
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
      if (!host) return 'no pane'
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

// The landing-page film, ~8.5 s at 30 fps: the question is typed and sent, the
// pane opens stripe.com as a desktop page, the iPhone joins it, the steps row
// shows and the reply streams in, ending on the still's composition. The
// conversation is the stored one, revealed a piece at a time; the panes are
// the real app's, and changes the app does not animate are crossfades.
async function story(win) {
  const sharp = (await import('sharp')).default
  const FW = 1920
  const FH = Math.round((H * FW) / W)
  rmSync(VIDEO, { recursive: true, force: true })
  mkdirSync(VIDEO, { recursive: true })
  const { copyFileSync } = await import('fs')
  let n = 0
  let last = null
  let lastFile = null
  const file = () => join(VIDEO, `f${String(n++).padStart(4, '0')}.png`)
  const grab = async () =>
    sharp(await win.screenshot()).resize(FW, FH).removeAlpha().raw().toBuffer()
  const put = async (raw) => {
    last = raw
    lastFile = file()
    await sharp(raw, { raw: { width: FW, height: FH, channels: 3 } })
      .png({ compressionLevel: 1 })
      .toFile(lastFile)
  }
  const shoot = async (st) => {
    await win.evaluate((s) => window.__hero(s), st)
    await win.waitForTimeout(40)
    await put(await grab())
  }
  const hold = (k) => {
    for (let i = 0; i < k; i++) copyFileSync(lastFile, file())
  }
  const ease = (t) => 1 - Math.pow(1 - t, 3)
  const smooth = (t) => t * t * (3 - 2 * t)
  let poster = null
  const fadeTo = async (b, k) => {
    const a = last
    for (let i = 1; i <= k; i++) {
      const t = smooth(i / k)
      const m = Buffer.alloc(a.length)
      for (let j = 0; j < a.length; j++) m[j] = a[j] + (b[j] - a[j]) * t + 0.5
      await put(i === k ? b : m)
    }
  }
  const crossfade = async (st, k, ready) => {
    const a = last
    if (!ready) await win.evaluate((s) => window.__hero(s), st)
    await win.waitForTimeout(60)
    const b = await grab()
    for (let i = 1; i <= k; i++) {
      const t = smooth(i / k)
      const m = Buffer.alloc(a.length)
      for (let j = 0; j < a.length; j++) m[j] = a[j] + (b[j] - a[j]) * t + 0.5
      await put(i === k ? b : m)
    }
  }

  const Q =
    'Open stripe.com and show it as desktop and iPhone side by side. Does the hero hold up on mobile?'
  await win.evaluate(() => {
    const visible = (sel) => [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null)
    const setInput = (v) => {
      const ta = visible('textarea.easy-input')
      if (!ta || ta.value === v) return
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // How much of a reply has "arrived": its text cut to the first n
    // characters, blocks with nothing in them yet left out.
    const stream = (el, n) => {
      const body = el.querySelector(':scope > .md')
      if (!body) return
      if (body.__full == null) body.__full = body.innerHTML
      body.innerHTML = body.__full
      if (n == null) return
      const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let left = n
      const texts = []
      while (walk.nextNode()) texts.push(walk.currentNode)
      for (const t of texts) {
        if (left <= 0) t.textContent = ''
        else if (t.textContent.length > left) t.textContent = t.textContent.slice(0, left)
        left -= t.textContent.length || 0
        if (left < 0) left = 0
      }
      for (const blk of body.querySelectorAll('p, li, ul, ol')) if (!blk.textContent.trim()) blk.style.display = 'none'
    }
    window.__heroReplyLength = () => {
      const tr = visible('.easy-transcript')
      const reply = tr.querySelectorAll('.easy-msg.easy-assistant')[1]
      stream(reply, null)
      const body = reply.querySelector(':scope > .md')
      return body.textContent.length
    }
    window.__hero = (st) => {
      const tr = visible('.easy-transcript')
      const user = tr.querySelector('.easy-msg.easy-user')
      const [open, reply] = tr.querySelectorAll('.easy-msg.easy-assistant')
      const tools = tr.querySelector('.easy-toolgroup')
      const show = (el, k) => {
        if (!el) return
        // Not display:none: the transcript is virtualized, and a row that
        // measures zero gets dropped. Hidden in place keeps every row where it is.
        el.style.visibility = k <= 0 ? 'hidden' : ''
        el.style.opacity = String(Math.max(0, k))
        el.style.transform = k < 1 ? `translateY(${((1 - k) * 12).toFixed(2)}px)` : ''
      }
      show(user, st.user)
      show(open, st.open)
      show(tools, st.tools)
      show(reply, st.reply === 0 ? 0 : 1)
      if (reply) stream(reply, st.reply == null || st.reply < 0 ? null : st.reply)
      for (const m of tr.querySelectorAll('.easy-msg-meta')) m.style.opacity = String(st.meta)
      setInput(st.input ?? '')
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
  })
  const base = { user: 0, open: 0, tools: 0, reply: 0, meta: 0, input: '' }
  const replyLen = await win.evaluate(() => window.__heroReplyLength())
  return {
    // The chat alone: the question is typed and sent, the first answer lands.
    async scene0() {
      await shoot(base)
      hold(11)
      for (let i = 1; i <= 30; i++) await shoot({ ...base, input: Q.slice(0, Math.round((Q.length * i) / 30)) })
      hold(8)
      for (let i = 1; i <= 7; i++) await shoot({ ...base, user: ease(i / 7) })
      hold(9)
      for (let i = 1; i <= 7; i++) await shoot({ ...base, user: 1, open: ease(i / 7) })
      hold(4)
    },
    // stripe.com opens in the pane as a desktop page.
    async scene1() {
      await crossfade({ ...base, user: 1, open: 1 }, 15)
      hold(15)
    },
    // The iPhone joins it; the steps row, then the reply streaming in.
    async scene2() {
      await crossfade({ ...base, user: 1, open: 1 }, 15)
      hold(6)
      for (let i = 1; i <= 6; i++) await shoot({ ...base, user: 1, open: 1, tools: ease(i / 6) })
      hold(4)
      const F = 80
      for (let i = 1; i <= F; i++)
        await shoot({ ...base, user: 1, open: 1, tools: 1, reply: Math.max(1, Math.round((replyLen * i) / F)) })
      for (let i = 1; i <= 8; i++)
        await shoot({ ...base, user: 1, open: 1, tools: 1, reply: -1, meta: ease(i / 8) })
      hold(36)
      poster = last
      // The first scene's last frame, full size: the poster is this exact
      // picture, and the film comes back to it at the end.
      await win.screenshot({ path: out })
      console.log('frames', n, 'reply chars', replyLen)
    },
    // Four conversations from four projects at once, in one window: each
    // working (the app's own Working row and sidebar spinner), its steps
    // counting up, its reply streaming in, at its own pace.
    async sceneSplit(pairs) {
      await win.evaluate((pairs) => {
        const st = window.__store.getState()
        const [[ws0, c0], ...rest] = pairs
        st.setActive(ws0)
        st.selectChat(ws0, c0)
        for (const [ws, c] of rest) window.__store.getState().openBeside(ws, c)
      }, pairs)
      await win.waitForTimeout(2500)
      await composite(win)
      // Per window: when its steps start, seconds between steps, when its
      // reply starts and how long it streams, the Working counter at t=0.
      const plan = [
        { steps: 0.4, every: 0.5, reply: 2.7, dur: 1.1, base: 14, verbs: ['Reading', 'Editing', 'Terminal'] },
        { steps: 0.0, every: 0.35, reply: 1.7, dur: 1.2, base: 41, verbs: ['Terminal', 'Reading', 'Searching', 'Editing', 'Terminal'] },
        { steps: 0.2, every: 0.55, reply: 4.1, dur: 1.1, base: 9, verbs: ['Reading', 'Editing', 'Editing', 'Terminal'] },
        { steps: 0.6, every: 0.5, reply: 3.3, dur: 1.2, base: 22, verbs: ['Searching', 'Reading', 'Editing', 'Editing', 'Terminal'] }
      ]
      await win.evaluate(({ pairs, plan }) => {
        const tiles = pairs.map(([, c], i) => ({ chat: c, ...plan[i] }))
        // The chat's own markup for a reply on its way (the mark, the counter),
        // as it draws it while its agent works.
        const working = () => {
          const d = document.createElement('div')
          d.className = 'easy-thinking __film'
          d.innerHTML = '<span class="easy-think-mark" aria-hidden="true"><span class="easy-think-dot"></span></span><span class="easy-elapsed"></span>'
          return d
        }
        const summary = (verbs) => {
          const acc = []
          for (const v of verbs) {
            const have = acc.find((a) => a.v === v)
            if (have) have.n++
            else acc.push({ v, n: 1 })
          }
          return acc.map((a) => (a.n > 1 ? `${a.v} ×${a.n}` : a.v)).join(' · ')
        }
        const busyNow = {}
        window.__split = (t) => {
          for (const tl of tiles) {
            const root = document.querySelector(`.workspace-view[data-desk="${tl.chat}"]`)
            const tr = root.querySelector('.easy-transcript')
            const reply = tr.querySelector('.easy-msg.easy-assistant')
            const group = tr.querySelector('.easy-toolgroup')
            const body = reply.querySelector(':scope > .md')
            if (body.__full == null) {
              body.__full = body.innerHTML
              body.__len = body.textContent.length
              group.__count = group.querySelector('.easy-tools-count').textContent
              group.__n = parseInt(group.__count, 10)
              group.__summary = group.querySelector('.easy-tools-summary').textContent
            }
            const done = tl.reply + tl.dur
            const k = t < tl.steps ? 0 : Math.min(group.__n, 1 + Math.floor((t - tl.steps) / tl.every))
            group.style.visibility = k ? '' : 'hidden'
            group.querySelector('.easy-tools-count').textContent =
              k === group.__n ? group.__count : `${k} step${k > 1 ? 's' : ''}`
            group.querySelector('.easy-tools-summary').textContent =
              k === group.__n ? group.__summary : summary(tl.verbs.slice(0, k))
            const chars = t < tl.reply ? 0 : Math.round(Math.min(1, (t - tl.reply) / tl.dur) * body.__len)
            reply.style.visibility = chars ? '' : 'hidden'
            body.innerHTML = body.__full
            if (chars < body.__len) {
              const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
              let left = chars
              const texts = []
              while (walk.nextNode()) texts.push(walk.currentNode)
              for (const x of texts) {
                if (x.textContent.length > left) x.textContent = x.textContent.slice(0, left)
                left -= x.textContent.length
              }
            }
            const meta = reply.querySelector('.easy-msg-meta')
            if (meta) meta.style.opacity = String(Math.max(0, Math.min(1, (t - done) / 0.3)))
            const scroll = tr.querySelector('.easy-scroll')
            let w = scroll.querySelector('.__film')
            if (t < done) {
              if (!w) scroll.appendChild((w = working()))
              w.querySelector('.easy-elapsed').textContent = `Working ${tl.base + Math.floor(t)}s`
              // Under the last thing on screen: the reply once it streams, else the steps.
              const last = chars ? reply : k ? group : tr.querySelector('.easy-msg.easy-user')
              const r = last.getBoundingClientRect()
              const s = scroll.getBoundingClientRect()
              // The mark sits on the bubbles' edge, as the chat's own row does.
              const edge = reply.getBoundingClientRect().left - s.left
              Object.assign(w.style, { position: 'absolute', left: `${edge}px`, right: '0', top: `${r.bottom - s.top + scroll.scrollTop + 10}px` })
              if (getComputedStyle(scroll).position === 'static') scroll.style.position = 'relative'
            } else if (w) w.remove()
            const busy = t < done
            if (busyNow[tl.chat] !== busy) {
              busyNow[tl.chat] = busy
              window.__store.getState().setBusy(tl.chat, { generating: busy, background: 0 })
            }
          }
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        }
      }, { pairs, plan })
      // The app's own animations (the working mark, the spinners) held to the film's clock.
      const at = async (t) => {
        await win.evaluate((t) => {
          window.__split(t)
          for (const a of document.getAnimations()) {
            a.pause()
            a.currentTime = t * 1000
          }
        }, t)
        await win.waitForTimeout(30)
      }
      await at(0)
      await win.waitForTimeout(300)
      await win.evaluate(() => window.__split(0))
      await crossfade(null, 18, true)
      for (let i = 1; i <= 180; i++) {
        await at(i / 30)
        await put(await grab())
      }
      hold(20)
    },
    // ⌘K over the split: the palette opens and finds a conversation by a
    // word in it, across every project.
    async scenePalette(query) {
      const clock = async (t) =>
        win.evaluate((t) => {
          for (const a of document.getAnimations()) {
            a.pause()
            a.currentTime = t * 1000
          }
        }, t)
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('menu:command-palette')
      })
      await win.waitForSelector('.cmdk-panel', { timeout: 5000 })
      await win.waitForTimeout(600)
      await clock(7)
      await crossfade(null, 9, true)
      let t = 7
      for (let i = 1; i <= query.length; i++) {
        await win.evaluate((v) => {
          const el = document.querySelector('.cmdk-input')
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }, query.slice(0, i))
        await win.waitForTimeout(250)
        for (let f = 0; f < 4; f++) {
          t += 1 / 30
          await clock(t)
          await put(await grab())
        }
      }
      await win.waitForTimeout(800)
      for (let f = 0; f < 50; f++) {
        t += 1 / 30
        await clock(t)
        await put(await grab())
      }
    },
    // Back to the first scene's last picture, which is also the poster.
    async finale() {
      await fadeTo(poster, 20)
      hold(45)
      console.log('frames', n)
    }
  }
}
