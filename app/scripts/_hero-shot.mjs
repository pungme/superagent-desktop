// The landing-page hero film, from a throwaway quiet instance (no window on
// screen) seeded with groups, projects, browser workspaces and stored
// conversations: no live agent, no tokens. See "The film" below for how the
// motion is captured.
//
//   npm run build && HERO_VIDEO=<frames dir> node scripts/_hero-shot.mjs <poster.png>
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
// Numbered frames go here; the poster (the last frame, full size) to `out`.
const VIDEO = resolve(process.env.HERO_VIDEO || join(tmpdir(), 'hero-film'))

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

  // ---------------------------------------------------------------------------
  // The film. Nothing in it is a dissolve: the page's own CSS animations and
  // transitions (a message arriving, the pane opening, the device frames
  // re-forming, split windows gliding, the palette opening) are frozen with the
  // DevTools animation clock and stepped a 30th of a second at a time. The
  // native browser views, which a page capture cannot see, are captured from
  // main and drawn at the measured rect of the element they sit in, frame by
  // frame, so they move with it. The conversations are the stored ones,
  // revealed as they would arrive.
  // ---------------------------------------------------------------------------
  const sharp = (await import('sharp')).default
  const { copyFileSync } = await import('fs')
  const FPS = 30
  const FW = 1920
  const FH = Math.round((H * FW) / W)
  const S = 2 // device pixels per CSS px in the capture
  rmSync(VIDEO, { recursive: true, force: true })
  mkdirSync(VIDEO, { recursive: true })

  for (let i = 0; i < 50 && !existsSync(urlFile); i++) await win.waitForTimeout(200)
  const mcpUrl = readFileSync(urlFile, 'utf8')
  // The agent's own browser tools, called the way Claude Code calls them.
  const tool = async (name, args = {}) => {
    const res = await fetch(`${mcpUrl}?ws=${encodeURIComponent(ids.landing)}&chat=${encodeURIComponent(ids.chat)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    return (await res.text()).slice(0, 200)
  }

  await win.evaluate(() => {
    const vis = (el) => el && el.offsetParent !== null
    // The sidebar is native vibrancy over a transparent body, which a page
    // capture sees through: a neutral stand-in, and the traffic lights.
    document.body.style.background = '#ececee'
    const lights = document.createElement('div')
    Object.assign(lights.style, { position: 'fixed', left: '20px', top: '14px', display: 'flex', gap: '8px', zIndex: '9999', pointerEvents: 'none' })
    for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
      const dot = document.createElement('span')
      Object.assign(dot.style, { width: '12px', height: '12px', borderRadius: '50%', background: color, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.12)' })
      lights.appendChild(dot)
    }
    document.body.appendChild(lights)

    // Every animation runs on the film's clock: started when first seen,
    // placed at (now - start), finished (so its end events fire) when done.
    window.__step = (t) => {
      for (const a of document.getAnimations()) {
        if (a.__t0 == null) a.__t0 = t
        const local = (t - a.__t0) * 1000
        const end = a.effect?.getComputedTiming?.().endTime ?? 0
        if (Number.isFinite(end) && local >= end) {
          try { a.finish() } catch { a.currentTime = end }
        } else a.currentTime = local
      }
    }
    // Where the native views sit: the device frames of the browser pane, or
    // the mini page of a narrow split window.
    window.__slots = () => {
      const out = []
      const host = [...document.querySelectorAll('.browser-host')].find(vis)
      if (host) {
        ;[...host.querySelectorAll('.browser-sim-frame')].filter(vis).forEach((f, i) => {
          const r = f.getBoundingClientRect()
          out.push({ kind: i ? 'phone' : 'card', x: r.left, y: r.top, w: r.width, h: r.height, r: parseFloat(getComputedStyle(f).borderTopLeftRadius) || 0 })
        })
      }
      for (const m of [...document.querySelectorAll('.mini-pane')].filter(vis)) {
        const r = m.getBoundingClientRect()
        out.push({ kind: 'mini', x: r.left, y: r.top, w: r.width, h: r.height, r: parseFloat(getComputedStyle(m).borderTopLeftRadius) || 0 })
      }
      return out
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
    const setInput = (ta, v) => {
      if (!ta || ta.value === v) return
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // Reveal a row the way it arrives: its own arrival animation, once.
    const show = (el, on) => {
      if (!el) return
      if (!on) {
        el.style.visibility = 'hidden'
        el.__on = false
        return
      }
      if (el.__on) return
      el.__on = true
      el.style.visibility = ''
      el.closest('.easy-vrow')?.classList.remove('no-anim')
      if (el.classList.contains('easy-msg')) {
        el.style.animation = 'none'
        void el.offsetWidth
        el.style.animation = ''
      }
    }
    const busyNow = {}
    // One conversation's state at a moment of the film.
    window.__chat = (id, st) => {
      const root = document.querySelector(`.workspace-view[data-desk="${id}"]`)
      const tr = root && root.querySelector('.easy-transcript')
      if (!tr || !tr.querySelector('.easy-msg')) return false
      const user = tr.querySelector('.easy-msg.easy-user')
      const as = [...tr.querySelectorAll('.easy-msg.easy-assistant')]
      const reply = as[as.length - 1]
      const open = as.length > 1 ? as[0] : null
      const group = tr.querySelector('.easy-toolgroup')
      const body = reply.querySelector(':scope > .md')
      if (body.__full == null) {
        body.__full = body.innerHTML
        body.__len = body.textContent.length
        group.__count = group.querySelector('.easy-tools-count').textContent
        group.__n = parseInt(group.__count, 10)
        group.__summary = group.querySelector('.easy-tools-summary').textContent
      }
      if (st.input !== undefined) setInput(root.querySelector('textarea.easy-input'), st.input)
      show(user, st.user)
      show(open, st.open)
      const k = Math.min(group.__n, st.steps)
      group.style.visibility = k >= 2 ? '' : 'hidden'
      group.querySelector('.easy-tools-count').textContent = k === group.__n ? group.__count : `${k} steps`
      group.querySelector('.easy-tools-summary').textContent = k === group.__n ? group.__summary : summary(st.verbs.slice(0, k))
      const chars = st.reply < 0 ? body.__len : Math.round(st.reply * body.__len)
      show(reply, chars > 0)
      if (body.__shown !== chars) {
        body.__shown = chars
        body.innerHTML = body.__full
        if (chars < body.__len) {
          const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          const texts = []
          while (walk.nextNode()) texts.push(walk.currentNode)
          let left = chars
          for (const x of texts) {
            if (x.textContent.length > left) x.textContent = x.textContent.slice(0, left)
            left -= x.textContent.length
          }
          for (const blk of body.querySelectorAll('p, li')) if (!blk.textContent.trim()) blk.style.display = 'none'
        }
      }
      for (const m of tr.querySelectorAll('.easy-msg-meta')) m.style.opacity = String(st.meta)
      // The chat's own "Working" row (its markup), under the last thing shown.
      const scroll = tr.querySelector('.easy-scroll')
      let w = scroll.querySelector('.__film')
      if (st.working != null) {
        if (!w) {
          w = document.createElement('div')
          w.className = 'easy-thinking __film'
          w.innerHTML = '<span class="easy-think-mark" aria-hidden="true"><span class="easy-think-dot"></span></span><span class="easy-elapsed"></span>'
          scroll.appendChild(w)
          if (getComputedStyle(scroll).position === 'static') scroll.style.position = 'relative'
        }
        w.querySelector('.easy-elapsed').textContent = `Working ${st.working}s`
        const last = [reply, group, open, user].find((e) => e && e.style.visibility !== 'hidden' && (e !== reply || chars > 0))
        const r = last.getBoundingClientRect()
        const s = scroll.getBoundingClientRect()
        const edge = (open || reply).getBoundingClientRect().left - s.left
        Object.assign(w.style, { position: 'absolute', left: `${edge}px`, right: '0', top: `${r.bottom - s.top + scroll.scrollTop + 10}px` })
      } else if (w) w.remove()
      const busy = st.working != null
      if (busyNow[id] !== busy) {
        busyNow[id] = busy
        window.__store.getState().setBusy(id, { generating: busy, background: 0 })
      }
      return true
    }
  })

  // ----- what each conversation is doing at time t -----
  const clamp = (x) => Math.max(0, Math.min(1, x))
  const Q = 'Open stripe.com and show it as desktop and iPhone side by side. Does the hero hold up on mobile?'
  const T = {
    typeFrom: 0.5, typeTo: 2.3, send: 2.5, open: 3.0, navigate: 3.6, both: 5.0, shot: 5.4,
    replyFrom: 5.8, replyTo: 8.3,
    adds: [9.3, 10.2, 11.1],
    palette: 15.6, typeK: 16.1, pick: 17.5, end: 19.7
  }
  const P = ids.chat
  const pricing = (t) => ({
    input: t < T.typeFrom ? '' : t < T.send ? Q.slice(0, Math.ceil(clamp((t - T.typeFrom) / (T.typeTo - T.typeFrom)) * Q.length)) : '',
    user: t >= T.send,
    open: t >= T.open,
    steps: t < T.navigate ? 0 : t < T.both ? 1 : t < T.shot ? 2 : 3,
    verbs: ['navigate', 'set viewport', 'screenshot'],
    reply: t < T.replyFrom ? 0 : t < T.replyTo ? Math.max(0.004, (t - T.replyFrom) / (T.replyTo - T.replyFrom)) : -1,
    meta: clamp((t - T.replyTo) / 0.25),
    working: t >= T.send && t < T.replyTo ? Math.floor(t - T.send) : null
  })
  const tiles = [
    { id: ids.split[1][1], add: T.adds[0], every: 0.42, reply: 11.3, dur: 1.2, base: 31, verbs: ['Terminal', 'Reading', 'Searching', 'Editing', 'Terminal'] },
    { id: ids.split[2][1], add: T.adds[1], every: 0.5, reply: 13.0, dur: 1.1, base: 12, verbs: ['Reading', 'Editing', 'Editing', 'Terminal'] },
    { id: ids.split[3][1], add: T.adds[2], every: 0.45, reply: 13.7, dur: 1.2, base: 20, verbs: ['Searching', 'Reading', 'Editing', 'Editing', 'Terminal'] }
  ]
  const tileState = (tl, t) => {
    const done = tl.reply + tl.dur
    return {
      user: true,
      open: false,
      steps: t < tl.add + 0.3 ? 0 : 1 + Math.floor((t - tl.add - 0.3) / tl.every),
      verbs: tl.verbs,
      reply: t < tl.reply ? 0 : t < done ? Math.max(0.004, (t - tl.reply) / tl.dur) : -1,
      meta: clamp((t - done) / 0.25),
      working: t < done ? tl.base + Math.floor(t - tl.add) : null
    }
  }

  // ----- the native views -----
  const images = {}
  const viewsNow = (withPng) =>
    app.evaluate(async ({ BrowserWindow }, withPng) => {
      const bw = BrowserWindow.getAllWindows()[0]
      const out = []
      for (const v of bw.contentView.children) {
        if (!v.webContents || !v.getVisible?.()) continue
        const b = v.getBounds()
        if (b.width < 20 || b.height < 20) continue
        let png = null
        if (withPng) {
          const img = await v.webContents.capturePage()
          if (img.isEmpty()) continue
          png = img.toPNG().toString('base64')
        }
        out.push({ ...b, png })
      }
      return out
    }, withPng)
  // Capture what each view shows now, and where it sits in its element.
  const capture = async () => {
    const views = await viewsNow(true)
    const slots = await win.evaluate(() => window.__slots())
    for (const v of views) {
      const cx = v.x + v.width / 2
      const cy = v.y + v.height / 2
      const s = slots
        .filter((s) => cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h)
        .sort((a, b) => a.w * a.h - b.w * b.h)[0]
      if (!s) continue
      images[s.kind] = {
        png: Buffer.from(v.png, 'base64'),
        fl: (v.x - s.x) / s.w,
        ft: (v.y - s.y) / s.h,
        fw: v.width / s.w,
        fh: v.height / s.h
      }
    }
    console.log('captured', Object.keys(images).join(','), 'slots', slots.map((s) => s.kind).join(','))
  }
  const tidy = () => tidyPages()

  // ----- frames -----
  let n = 0
  let lastFile = null
  const mask = (w, h, r) =>
    Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`)
  const render = async (full) => {
    const [png, slots, vis] = await Promise.all([
      win.screenshot(),
      win.evaluate(() => window.__slots()),
      viewsNow(false)
    ])
    const layers = []
    if (vis.length)
      for (const s of slots) {
        const im = images[s.kind]
        if (!im) continue
        let x = Math.round((s.x + im.fl * s.w) * S)
        let y = Math.round((s.y + im.ft * s.h) * S)
        let w = Math.round(im.fw * s.w * S)
        let h = Math.round(im.fh * s.h * S)
        if (w < 4 || h < 4) continue
        const r = Math.round(s.r * S)
        let buf = await sharp(im.png).resize(w, h, { fit: 'fill' }).ensureAlpha()
          .composite([{ input: mask(w, h, r), blend: 'dest-in' }]).png().toBuffer()
        // Keep it inside the window.
        const cx = Math.max(0, -x)
        const cy = Math.max(0, -y)
        const cw = Math.min(w - cx, W * S - (x + cx))
        const ch = Math.min(h - cy, H * S - (y + cy))
        if (cw < 2 || ch < 2) continue
        if (cx || cy || cw !== w || ch !== h) buf = await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).toBuffer()
        layers.push({ input: buf, left: x + cx, top: y + cy })
      }
    const img = sharp(await sharp(png).composite(layers).png().toBuffer())
    if (full) await img.clone().toFile(full)
    lastFile = join(VIDEO, `f${String(n++).padStart(4, '0')}.png`)
    await img.resize(FW, FH).removeAlpha().png({ compressionLevel: 1 }).toFile(lastFile)
  }
  // One frame at time t: every conversation where it is, the clock moved on.
  const frame = async (t, full) => {
    const chats = [{ id: P, st: pricing(t) }, ...tiles.filter((tl) => t >= tl.add).map((tl) => ({ id: tl.id, st: tileState(tl, t) }))]
    await win.evaluate(({ chats, t }) => {
      for (const c of chats) window.__chat(c.id, c.st)
      window.__step(t)
      if (document.activeElement instanceof HTMLElement && !document.activeElement.matches('.cmdk-input'))
        document.activeElement.blur()
    }, { chats, t })
    await render(full)
  }
  let t = 0
  const until = async (to) => {
    while (t + 1e-6 < to) {
      await frame(t)
      t = Math.round((t + 1 / FPS) * 1e6) / 1e6
    }
  }

  // Start: the conversation, nothing in it yet; the clock frozen.
  await win.evaluate((st) => window.__chat(st.id, st.st), { id: P, st: pricing(0) })
  const cdp = await win.context().newCDPSession(win)
  await cdp.send('Animation.enable')
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 })

  // 1. The question is typed and sent; the pane opens on stripe.com; the
  //    iPhone joins it; the reply streams in.
  await until(T.navigate)
  console.log(await tool('browser_navigate', { url: 'https://stripe.com/en-us' }))
  await win.waitForTimeout(6000)
  await tidy()
  await capture()
  await until(T.both)
  console.log(await tool('browser_set_viewport', { viewport: 'both' }))
  await win.waitForTimeout(8000)
  await tidy()
  await capture()
  await until(T.adds[0])

  // 2. The window becomes the first of a split; three more conversations
  //    open beside it one at a time, each gliding in as the others make room.
  for (const [i, tl] of tiles.entries()) {
    await win.evaluate(([ws, c]) => window.__store.getState().openBeside(ws, c), ids.split[i + 1])
    await win.waitForTimeout(i === 0 ? 2500 : 900)
    if (i === 0) await capture()
    await until(i + 1 < tiles.length ? tiles[i + 1].add : T.palette)
  }

  // 3. ⌘K: the palette opens, "login" is typed, the list narrows to the
  //    conversation, and picking it brings its window forward.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command-palette'))
  await win.waitForSelector('.cmdk-panel', { timeout: 5000 })
  await win.waitForTimeout(400)
  await until(T.typeK)
  for (let i = 1; i <= 5; i++) {
    await win.evaluate((v) => {
      const el = document.querySelector('.cmdk-input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, 'login'.slice(0, i))
    await win.waitForTimeout(300)
    await until(T.typeK + i * 0.1)
  }
  await until(T.pick)
  await win.evaluate(() => {
    const hit = [...document.querySelectorAll('.cmdk-item')].find((e) => e.textContent.includes('Fix the flaky login test'))
    hit?.click()
  })
  await win.waitForTimeout(600)
  await until(T.end)
  // The last frame, full size: the poster is this exact picture.
  await frame(t, out)
  console.log('frames', n)
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
