// The landing page's clips (docs/media), filmed exactly as _tour-clips.mjs films
// the tour's: same quiet instance, same stored chats, same frame-by-frame camera.
// Adds the scenes the tour does not have (worktrees, computer). Projects live
// under /tmp/Land/work.
//
// (from _tour-clips.mjs:) The onboarding tour's clips: short silent recordings of the real app, one
// per scene, for src/renderer/src/tour/clips/. A throwaway quiet instance (no
// window on screen, no real mouse or keys) is seeded with projects and stored
// conversations (no live agent, no tokens), and filmed frame by frame at
// 30 fps on a virtual clock: every CSS animation and transition in the window
// is paused and stepped, so what moves is the app's own motion, at its own
// speed. Native browser panes are composited in, as _hero-shot.mjs does.
//
//   npm run build && node scripts/_tour-clips.mjs <outDir> [home|build|split|routines|keys ...]
//
// Writes <scene>.mp4 and <scene>.jpg (the poster) to outDir. Its projects live
// under /tmp/Work, which it makes and removes; it refuses to run if that exists.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { createServer } from 'http'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(process.argv[2] || join(tmpdir(), 'tour-clips'))
const only = process.argv.slice(3)
// The window filmed: the tour frame's shape (960×565), small enough that the
// app's text still reads in the tour.
const W = Number(process.env.CLIP_W || 1190)
const H = Number(process.env.CLIP_H || 700)
// The clip: about 2× the frame's size on screen.
const FW = 1920
const FH = Math.round((H * FW) / W / 2) * 2
const FPS = 30
const ffmpeg = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'])
  .toString()
  .trim()
const root = '/tmp/Land/work'
if (existsSync(root)) throw new Error(`${root} exists; not touching it`)
mkdirSync(outDir, { recursive: true })
mkdirSync('/tmp/Land', { recursive: true })

// A small shop on localhost for the browser scene: a page with a sign-up form
// the agent really fills in.
const SHOP = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fern — plants, delivered</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#1d2a1f;background:#f7f5ef}
nav{display:flex;align-items:center;gap:28px;padding:18px 40px;font-size:15px}nav b{font-size:20px;letter-spacing:-.02em;margin-right:auto}
nav a{color:#4a5a4c;text-decoration:none}nav .cta{background:#1d2a1f;color:#fff;padding:8px 16px;border-radius:999px}
main{display:grid;grid-template-columns:1.1fr .9fr;gap:48px;align-items:center;padding:56px 40px 40px;max-width:1200px;margin:0 auto}
h1{font-size:60px;line-height:1.02;letter-spacing:-.035em;margin:0 0 18px}p.lede{font-size:19px;color:#4a5a4c;margin:0 0 28px;max-width:30ch}
form{display:flex;gap:10px;flex-wrap:wrap}input{flex:1;min-width:200px;font:inherit;padding:13px 16px;border-radius:12px;border:1px solid #cfd6cb;background:#fff}
button{font:inherit;font-weight:600;padding:13px 22px;border-radius:12px;border:0;background:#2f6b3a;color:#fff}
.art{aspect-ratio:1;border-radius:28px;background:radial-gradient(circle at 30% 30%,#9fc79a,#2f6b3a 70%);position:relative;overflow:hidden}
.art i{position:absolute;border-radius:50% 0;background:#cfe6c6;opacity:.85}
.ok{display:none;padding:14px 18px;border-radius:12px;background:#e3f1df;color:#1f5a2b;font-weight:600}
body.done form{display:none}body.done .ok{display:block}
@media (max-width:700px){nav{padding:14px 20px}nav a:not(.cta){display:none}main{grid-template-columns:1fr;padding:24px 20px;gap:28px}h1{font-size:40px}.art{order:-1;aspect-ratio:4/3}}
</style></head><body>
<nav><b>Fern</b><a href="#">Shop</a><a href="#">Care guides</a><a href="#">Gifts</a><a class="cta" href="#">Join</a></nav>
<main><div><h1>Plants that arrive happy.</h1><p class="lede">Grown in the greenhouse, packed by hand, at your door in two days.</p>
<form onsubmit="event.preventDefault();document.body.classList.add('done')"><input placeholder="Your email" type="email"><button>Sign up</button></form>
<div class="ok">Welcome aboard. Your first plant is on us.</div></div>
<div class="art"><i style="width:46%;height:46%;left:12%;top:40%;transform:rotate(-20deg)"></i><i style="width:38%;height:38%;left:48%;top:18%;transform:rotate(40deg)"></i><i style="width:30%;height:30%;left:50%;top:60%;transform:rotate(10deg)"></i></div></main>
</body></html>`

async function serveShop() {
  for (const port of [5173, 4173, 5174, 0]) {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(SHOP)
    })
    const ok = await new Promise((r) => {
      srv.once('error', () => r(false))
      srv.listen(port, '127.0.0.1', () => r(true))
    })
    if (ok) return { srv, port: srv.address().port }
  }
  throw new Error('no port')
}

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

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'land-clip-data-'))
  const urlFile = join(userData, 'mcp-url.txt')
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
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow, nativeTheme }, [w, h]) => {
    nativeTheme.themeSource = 'light'
    BrowserWindow.getAllWindows()[0].setContentSize(w, h)
  }, [W, H])
  await win.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
    localStorage.setItem('cove.tourSeen', '1')
    localStorage.setItem('cove.e2e', '1')
    localStorage.setItem('cove.theme', 'light')
  })
  await win.reload()
  await win.waitForSelector('.sidebar', { timeout: 20_000 })
  return { app, win, userData, urlFile }
}

// Projects and stored conversations, finished: a scene reveals or works them.
async function seed(win, dirs) {
  const now = Date.now()
  return win.evaluate(
    async ({ dirs, now }) => {
      const cove = window.cove
      const gid = async (name) => (await cove.createGroup(name)).find((g) => g.name === name).id
      const personal = await gid('Personal')
      const work = await gid('Work')
      const mk = async (g, n) => (await cove.createWorkspace(g, n, dirs[n])).workspaceId
      const ws = {}
      for (const n of ['landing-page', 'shop-web', 'mobile-app', 'design-system']) ws[n] = await mk(work, n)
      for (const n of ['notes-app']) ws[n] = await mk(personal, n)
      const tool = (id, name, detail) => ({ kind: 'tool', tool: { id, name, detail } })
      const chats = {}
      const said = async (w, title, ask, tools, answer, ago = 90e3, before = []) => {
        const id = await cove.chatCreate(ws[w])
        await cove.chatUpdate(id, { title })
        cove.chatSave(
          id,
          JSON.stringify([
            ...before.flatMap(([q, a], i) => [
              { kind: 'msg', msg: { id: id + 'pu' + i, role: 'user', text: q, at: now - ago - 600e3 } },
              { kind: 'msg', msg: { id: id + 'pa' + i, role: 'assistant', text: a, at: now - ago - 560e3 } }
            ]),
            { kind: 'msg', msg: { id: id + 'u', role: 'user', text: ask, at: now - ago } },
            ...tools.map(([n, d], i) => tool(id + 't' + i, n, d)),
            { kind: 'msg', msg: { id: id + 'a', role: 'assistant', text: answer, at: now - ago + 40e3, tokens: 48000, tokensNew: 2100 } }
          ])
        )
        chats[title] = { ws: ws[w], chat: id }
        return id
      }
      // Made in the order the sidebar should list them, oldest first.
      await said('landing-page', 'Pricing page refresh', 'Make the pricing page match the new plans: Free, Pro, Team.',
        [['Read', 'src/pages/Pricing.tsx'], ['Edit', 'src/pages/Pricing.tsx'], ['Bash', 'npm run build']],
        'Three plans now, side by side. **Team** carries the "most popular" badge, and the yearly toggle shows the saving on each card.\n\nI kept the FAQ under the cards, and moved "Compare all features" into a table you can open.', 4 * 3600e3,
        [['What do the plans look like on the current page?', 'Two plans, Starter and Business, with the prices in a sentence rather than on cards. The page still mentions the old 14-day trial.']])
      await said('landing-page', 'Tighten the hero copy', 'Make the headline shorter, keep the tone.',
        [['Read', 'src/Hero.tsx'], ['Edit', 'src/Hero.tsx'], ['Bash', 'npm run build']],
        'Two lines instead of three. I cut "for teams of any size": it was doing nothing, and the sentence lands harder without it.', 3600e3)
      await said('mobile-app', 'Fix the flaky login test', 'The login e2e fails about one run in five. Find out why.',
        [['Bash', 'npx playwright test login'], ['Read', 'e2e/login.spec.ts'], ['Grep', 'waitForURL'], ['Edit', 'e2e/login.spec.ts'], ['Bash', 'npx playwright test login --repeat-each 30']],
        'It races the session cookie: the test taps before the redirect lands. It now waits for the URL, and **30 runs in a row are green**.\n\nThe fix is one line in `e2e/login.spec.ts`. Want me to push it and open a pull request?', 90e3,
        [['CI went red again on main. What failed?', 'Only `login.spec.ts`, on the iPhone 15 project. The other 212 tests passed. It is the same test that failed on Tuesday, so it looks flaky rather than broken.']])
      await said('mobile-app', 'Migrate to pnpm', 'Move this repo to pnpm.',
        [['Bash', 'pnpm import'], ['Edit', 'package.json'], ['Edit', '.github/workflows/ci.yml'], ['Bash', 'pnpm test']],
        'Done: the lockfile is converted, CI uses pnpm, and the tests pass. Installs went from 48 s to 11 s.', 2 * 3600e3)
      await said('design-system', 'Dark mode tokens', 'Add dark variants for the surface and border tokens.',
        [['Read', 'tokens/color.json'], ['Edit', 'tokens/color.json'], ['Edit', 'tokens/dark.json'], ['Bash', 'npm run build:tokens']],
        'Added dark surface, border and both hover states. Every pair passes AA contrast, and the token build is clean.')
      await said('notes-app', 'Export to Markdown', 'Add Export as Markdown to the File menu.',
        [['Grep', 'File menu'], ['Read', 'src/menu.ts'], ['Edit', 'src/menu.ts'], ['Edit', 'src/export.ts'], ['Bash', 'npm test']],
        'File › Export as Markdown is in, on ⇧⌘E. Headings, lists and checkboxes round-trip, and images are saved beside the file.')
      await said('shop-web', 'Check the sign-up form', 'Open the shop on localhost and check that signing up still works, on desktop and on a phone.',
        [['mcp__cove-browser__browser_navigate', 'http://localhost:5173'], ['mcp__cove-browser__browser_click', 'Your email'], ['mcp__cove-browser__browser_type', 'ana@example.com'], ['mcp__cove-browser__browser_click', 'Sign up'], ['mcp__cove-browser__browser_set_viewport', 'both'], ['mcp__cove-browser__browser_screenshot', '']],
        'Signing up works: the form takes the email and the welcome line shows. On a phone the picture moves above the headline and **the form stays on one screen**, no scrolling.', 60e3)
      return { ws, chats }
    },
    { dirs, now }
  )
}

// The film: every animation in the window held to a clock that moves only
// when a frame is taken. An animation is placed at the time since the frame
// it first appeared in, so things the app starts mid-film begin at their start.
async function camera(win, app, name, { composite = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `land-clip-${name}-`))
  let n = 0
  let ms = 0
  await win.evaluate(() => {
    const seen = new WeakMap()
    window.__clock = (t) => {
      for (const a of document.getAnimations()) {
        if (!seen.has(a)) seen.set(a, t)
        a.pause()
        a.currentTime = Math.max(0, t - seen.get(a))
      }
      window.dispatchEvent(new CustomEvent('cove:layout-moved'))
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  const settle = async () => {
    await win.evaluate((t) => window.__clock(t), ms)
    await win.waitForTimeout(composite ? 90 : 35)
    await win.evaluate((t) => window.__clock(t), ms)
    if (composite) await compositeViews(app, win)
  }
  const frame = async () => {
    await settle()
    const png = await win.screenshot()
    await sharp(png).resize(FW, FH).removeAlpha().png({ compressionLevel: 1 }).toFile(join(dir, `f${String(n++).padStart(4, '0')}.png`))
    ms += 1000 / FPS
  }
  return {
    dir,
    frame,
    /** k frames of whatever the app is doing. */
    async run(k, each) {
      for (let i = 0; i < k; i++) {
        if (each) await each(i)
        await frame()
      }
    },
    async seconds(s, each) {
      await this.run(Math.round(s * FPS), each)
    },
    get frames() {
      return n
    },
    async encode(posterAt) {
      const mp4 = join(outDir, `${name}.mp4`)
      const crf = process.env.CLIP_CRF || '18'
      execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%04d.png'),
        '-an', '-c:v', 'libx264', '-preset', 'veryslow', '-crf', crf, '-pix_fmt', 'yuv420p', '-tune', 'animation',
        '-movflags', '+faststart', mp4])
      const p = Math.min(n - 1, posterAt ?? n - 1)
      await sharp(join(dir, `f${String(p).padStart(4, '0')}.png`)).jpeg({ quality: 82, mozjpeg: true }).toFile(join(outDir, `${name}.jpg`))
      rmSync(dir, { recursive: true, force: true })
      console.log(name, n, 'frames', (n / FPS).toFixed(1) + 's')
    }
  }
}

// The panes are native views a capture of the page cannot see: capture each
// at its own bounds and lay the picture over that exact spot.
const lastPicture = new Map()
let lastViews = []
async function compositeViews(app, win) {
  let views = await app.evaluate(async ({ BrowserWindow, webContents }, last) => {
    const bw = BrowserWindow.getAllWindows()[0]
    const out = []
    for (const v of bw.contentView.children) {
      if (!v.webContents || !v.getVisible?.()) continue
      const b = v.getBounds()
      if (b.width < 20 || b.height < 20) continue
      const img = await v.webContents.capturePage()
      out.push({ ...b, id: v.webContents.id, png: img.isEmpty() ? null : img.toPNG().toString('base64') })
    }
    // While the agent acts on a page in a quiet test instance, its view is
    // taken off the window for a moment; on a real screen it stays. Keep
    // showing it where it was, as it is now.
    if (!out.length)
      for (const v of last) {
        const wc = webContents.fromId(v.id)
        if (!wc) continue
        const img = await wc.capturePage().catch(() => null)
        out.push({ ...v, png: img && !img.isEmpty() ? img.resize({ width: v.width * 2, height: v.height * 2 }).toPNG().toString('base64') : null })
      }
    return out
  }, lastViews.map(({ png, ...v }) => v))
  if (views.length) lastViews = views
  // A page busy at that instant can give back nothing: it still shows what it
  // showed a frame ago.
  for (const v of views) {
    if (v.png) lastPicture.set(v.id, v.png)
    else v.png = lastPicture.get(v.id)
  }
  views = views.filter((v) => v.png)
  await win.evaluate((views) => {
    document.querySelectorAll('.__shot_overlay').forEach((n) => n.remove())
    const host = [...document.querySelectorAll('.browser-host')].find((h) => h.offsetParent !== null)
    if (!host) return
    const hr = host.getBoundingClientRect()
    const frames = [...host.querySelectorAll('.browser-sim-frame')].filter((f) => f.offsetParent !== null)
    for (const v of views) {
      const f = frames.find((fr) => {
        const r = fr.getBoundingClientRect()
        return v.x >= r.left - 2 && v.x + v.width <= r.right + 2 && v.y >= r.top - 2 && v.y + v.height <= r.bottom + 2
      })
      const clip = document.createElement('div')
      clip.className = '__shot_overlay'
      Object.assign(clip.style, { position: 'absolute', left: `${v.x - hr.left}px`, top: `${v.y - hr.top}px`, width: `${v.width}px`, height: `${v.height}px`, overflow: 'hidden', borderRadius: f ? getComputedStyle(f).borderRadius : '0', pointerEvents: 'none', zIndex: '5' })
      const img = document.createElement('img')
      img.src = `data:image/png;base64,${v.png}`
      Object.assign(img.style, { display: 'block', width: '100%', height: '100%' })
      clip.appendChild(img)
      host.appendChild(clip)
    }
  }, views)
  await win.waitForFunction(() => [...document.querySelectorAll('.__shot_overlay img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 }).catch(() => {})
}

// The sidebar is native vibrancy over a transparent body, which a page capture
// sees through: stand in its light tone, and the traffic lights.
async function chrome(win) {
  await win.evaluate(() => {
    document.body.style.background = '#ececee'
    const lights = document.createElement('div')
    Object.assign(lights.style, { position: 'fixed', left: '20px', top: '14px', display: 'flex', gap: '8px', zIndex: '9999', pointerEvents: 'none' })
    for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
      const dot = document.createElement('span')
      Object.assign(dot.style, { width: '12px', height: '12px', borderRadius: '50%', background: color, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.12)' })
      lights.appendChild(dot)
    }
    document.body.appendChild(lights)
  })
}

const open = async (win, ws, chat) => {
  await win.evaluate(([ws, chat]) => {
    const st = window.__store.getState()
    st.setActive(ws)
    st.selectChat(ws, chat)
  }, [ws, chat])
  await win.waitForTimeout(900)
}

// ---------- The scenes ----------

const scenes = {
  // A chat on its own branch: it appears under its project with the branch
  // under its name, its conversation fills in, the Worktrees pill says where it
  // works, and ⋯ offers to keep the work or throw it away.
  async worktrees({ win, app, ids }) {
    const c = ids.chats
    const ws = c['Pricing page refresh'].ws
    await open(win, ws, c['Pricing page refresh'].chat)
    await win.click('.sidebar-mode:has-text("Projects")')
    await chrome(win)
    const projectPath = join(root, 'landing-page')
    const wt = await win.evaluate((p) => window.cove.worktreeCreate(p, { newBranch: 'pricing-cards' }), projectPath)
    const g = (...a) => execFileSync('git', ['-c', 'user.name=Superagent', '-c', 'user.email=x@x', ...a], { cwd: wt.path, stdio: 'ignore' })
    writeFileSync(join(wt.path, 'Pricing.tsx'), 'export const plans = ["Free", "Pro", "Team"]\n')
    g('add', '.'); g('commit', '-qm', 'Pricing: three cards side by side')
    writeFileSync(join(wt.path, 'Pricing.css'), '.cards { display: grid; grid-template-columns: repeat(3, 1fr) }\n')
    g('add', '.'); g('commit', '-qm', 'Pricing: the yearly toggle')
    const now = Date.now()
    const chat = await win.evaluate(async ({ ws, path, now }) => {
      const cove = window.cove
      const id = await cove.chatCreate(ws, path)
      await cove.chatUpdate(id, { title: 'Pricing cards' })
      const tool = (i, name, detail) => ({ kind: 'tool', tool: { id: id + 't' + i, name, detail } })
      await cove.chatSave(id, JSON.stringify([
        { kind: 'msg', msg: { id: id + 'u', role: 'user', text: 'Turn the three plans into cards, side by side, with a yearly toggle.', at: now - 50e3 } },
        tool(0, 'Read', 'src/pages/Pricing.tsx'), tool(1, 'Edit', 'src/pages/Pricing.tsx'), tool(2, 'Edit', 'src/pages/Pricing.css'),
        tool(3, 'Bash', 'npm run build'), tool(4, 'Bash', 'git commit -m "Pricing: three cards side by side"'), tool(5, 'Bash', 'git commit -m "Pricing: the yearly toggle"'),
        { kind: 'msg', msg: { id: id + 'a', role: 'assistant', text: 'Three cards, side by side, and a yearly toggle that shows the saving on each. **Two commits on `pricing-cards`.**\n\nYour own copy of the project is untouched. Keep it, and it lands on main as one change. Or throw it away, and nothing happened.', at: now - 5e3, tokens: 41000, tokensNew: 1800 } }
      ]))
      return id
    }, { ws, path: wt.path, now })
    const cam = await camera(win, app, 'worktrees')
    await cam.seconds(0.8)
    // The chat arrives under its project, on its own branch, and opens.
    await win.evaluate(async ([ws, id]) => {
      const st = window.__store.getState()
      const list = await window.cove.chatList(ws)
      window.__store.setState((s) => ({ chats: { ...s.chats, [ws]: list } }))
      st.selectChat(ws, id)
    }, [ws, chat])
    await win.waitForTimeout(700)
    await win.evaluate((ws) => window.dispatchEvent(new CustomEvent('cove:workspace-idle', { detail: { workspaceId: ws } })), ws)
    await win.waitForTimeout(500)
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await cam.seconds(2.0)
    // Where it works: its own copy, on its own branch.
    await win.click('.easy-control-btn:has-text("Worktrees") >> visible=true')
    await win.waitForTimeout(300)
    await cam.seconds(2.2)
    await win.click('.easy-control-btn:has-text("Worktrees") >> visible=true')
    await win.mouse.move(2, H - 2)
    await cam.seconds(0.5)
    // Keep it, or throw it away.
    await win.click('.easy-more-btn >> visible=true')
    await win.waitForTimeout(300)
    await win.mouse.move(2, H - 2)
    await cam.seconds(2.6)
    await cam.encode(cam.frames - 1)
  },

  // The Computer: a desktop of its own inside the window. Apps open from the
  // dock as windows that stack and cascade.
  async computer({ win, app, ids }) {
    const c = ids.chats
    const { ws } = c['Fix the flaky login test']
    await open(win, c['Pricing page refresh'].ws, c['Pricing page refresh'].chat)
    await win.evaluate(async ([ws, path]) => {
      await window.cove.routinesCreate(ws, path, 'Run the e2e suite against staging and tell me what broke', 24 * 60)
      await window.cove.routinesCreate(ws, path, 'Look for new crash reports in Sentry and sort them by how many people they hit', 60)
    }, [ws, join(root, 'mobile-app')])
    // The Computer's own chat, with a conversation in it.
    const home = await win.evaluate(async (now) => {
      const cove = window.cove
      const home = await cove.desktopChatHome()
      const mk = async (title, ask, tools, answer, ago) => {
        const id = await cove.chatCreate(home.workspaceId)
        await cove.chatUpdate(id, { title })
        await cove.chatSave(id, JSON.stringify([
          { kind: 'msg', msg: { id: id + 'u', role: 'user', text: ask, at: now - ago } },
          ...tools.map(([n, d], i) => ({ kind: 'tool', tool: { id: id + 't' + i, name: n, detail: d } })),
          { kind: 'msg', msg: { id: id + 'a', role: 'assistant', text: answer, at: now - ago + 30e3, tokens: 30000, tokensNew: 1200 } }
        ]))
        return id
      }
      await mk('Weekly numbers', 'Sum up this week’s sign-ups from the CSV on the desk.', [['Read', 'signups.csv']], '**1,284 sign-ups**, up 9% on last week. Tuesday was the best day, after the newsletter went out.', 7200e3)
      const id = await mk('Plan the launch week', 'Put the launch plan on my calendar: blog post Monday, video Wednesday, the newsletter Friday.', [['computer_calendar_add', 'Blog post · Mon 10:00'], ['computer_calendar_add', 'Launch video · Wed 14:00'], ['computer_calendar_add', 'Newsletter · Fri 09:00']], 'Three events are on your calendar: the **blog post** on Monday at 10, the **video** on Wednesday at 2, and the **newsletter** on Friday at 9.', 60e3)
      // What that conversation put on the calendar, in this week's grid.
      const d = new Date(now)
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
      const day = (k) => { const x = new Date(d); x.setDate(d.getDate() + k); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }
      for (const [k, t0, t1, title, color] of [[0, '10:00', '11:30', 'Blog post', '#3b82f6'], [2, '14:00', '15:30', 'Launch video', '#a855f7'], [4, '09:00', '10:00', 'Newsletter', '#22c55e']])
        await cove.calendarAdd({ title, start: `${day(k)}T${t0}`, end: `${day(k)}T${t1}`, allDay: false, notes: '', color })
      return { ...home, chat: id }
    }, Date.now())
    // Two windows already out on the desk, where you left them.
    await win.evaluate(() => localStorage.setItem('cove.computerWindows', JSON.stringify([
      { id: 'chat-1', app: 'chat', rect: { x: 24, y: 20, w: 620, h: 560 }, z: 1, minimized: false, maximized: false },
      { id: 'routines-1', app: 'routines', rect: { x: 670, y: 70, w: 590, h: 400 }, z: 2, minimized: false, maximized: false }
    ])))
    await win.reload()
    await win.waitForSelector('.sidebar-item:has-text("landing-page")', { timeout: 20_000 })
    await open(win, c['Fix the flaky login test'].ws, c['Fix the flaky login test'].chat)
    await win.click('.sidebar-mode:has-text("Projects")')
    await win.evaluate(([w, id]) => window.__store.setState((s) => ({ activeChatId: { ...s.activeChatId, [w]: id } })), [home.workspaceId, home.chat])
    await chrome(win)
    const cam = await camera(win, app, 'computer')
    await cam.seconds(0.6)
    await win.click('.sidebar-dash-row')
    await win.waitForTimeout(500)
    await win.mouse.move(2, H - 2)
    await cam.seconds(0.9)
    await win.click('.dock-app[title="Open Calendar"]')
    await win.waitForTimeout(400)
    await win.mouse.move(2, H - 2)
    await cam.seconds(1.6)
    // The chat, brought forward with a click on its title.
    await win.click('.dw:has(.dw-title:has-text("Chat")) .dw-title')
    await win.waitForTimeout(300)
    await win.mouse.move(2, H - 2)
    await cam.seconds(1.6)
    await cam.seconds(0.4)
    await cam.encode(cam.frames - 1)
  },

  // Several chats at work on one rail: spinners, one finishes and earns its
  // dot, then it is opened.
  async home({ win, app, ids }) {
    const c = ids.chats
    await open(win, c['Pricing page refresh'].ws, c['Pricing page refresh'].chat)
    // Activity: every chat of every project on one rail, newest first.
    await win.click('.sidebar-mode:has-text("Activity")')
    await chrome(win)
    const busy = (title, on) =>
      win.evaluate(([id, on]) => window.__store.getState().setBusy(id, { generating: on, background: 0 }), [c[title].chat, on])
    const cam = await camera(win, app, 'home')
    await cam.seconds(0.6)
    await busy('Tighten the hero copy', true)
    await cam.seconds(0.5)
    await busy('Fix the flaky login test', true)
    await cam.seconds(0.4)
    await busy('Dark mode tokens', true)
    await cam.seconds(0.5)
    await busy('Export to Markdown', true)
    await cam.seconds(1.6)
    // One finishes while you look elsewhere: the spinner gives way to the dot.
    await busy('Fix the flaky login test', false)
    await win.evaluate((id) => window.__store.getState().markUnread(id), c['Fix the flaky login test'].chat)
    await cam.seconds(1.4)
    // Opened from the rail, as you would.
    await win.click('.activity-row:has-text("Fix the flaky login test")')
    await win.waitForTimeout(500)
    await cam.seconds(2.6)
    await cam.encode(Math.round(3.8 * FPS))
  },

  // The browser beside the chat: the agent opens the page, fills in the form,
  // checks it on a phone, and says what it found.
  async build({ win, app, ids, urlFile, shop }) {
    const { ws, chat } = ids.chats['Check the sign-up form']
    await open(win, ws, chat)
    await chrome(win)
    for (let i = 0; i < 50 && !existsSync(urlFile); i++) await win.waitForTimeout(200)
    const mcpUrl = readFileSync(urlFile, 'utf8')
    const tool = async (name, args = {}) => {
      const res = await fetch(`${mcpUrl}?ws=${encodeURIComponent(ws)}&chat=${encodeURIComponent(chat)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      })
      return (await res.text()).slice(0, 200)
    }
    // The stored conversation, shown a piece at a time: its steps listed open.
    await win.click('.easy-tools-toggle')
    await win.waitForTimeout(300)
    await win.evaluate(() => {
      const tr = [...document.querySelectorAll('.easy-transcript')].find((e) => e.offsetParent !== null)
      const hide = (el, on) => {
        if (!el) return
        // Not display:none: the transcript is virtualized, and a row that
        // measures zero is dropped. Hidden in place keeps every row where it is.
        el.style.visibility = on ? '' : 'hidden'
      }
      const working = document.createElement('div')
      working.className = 'easy-thinking __film'
      working.innerHTML = '<span class="easy-think-mark" aria-hidden="true"><span class="easy-think-dot"></span></span><span class="easy-elapsed"></span>'
      window.__build = ({ steps, reply, meta, secs }) => {
        const group = tr.querySelector('.easy-toolgroup')
        const rows = [...group.querySelectorAll('.easy-toolrow')]
        hide(group, steps > 0)
        rows.forEach((r, i) => hide(r, i < steps))
        group.querySelector('.easy-tools-count').textContent = `${Math.max(1, steps)} step${steps > 1 ? 's' : ''}`
        const answer = tr.querySelector('.easy-msg.easy-assistant')
        const body = answer.querySelector(':scope > .md')
        if (body.__full == null) {
          body.__full = body.innerHTML
          body.__len = body.textContent.length
        }
        hide(answer, reply > 0)
        body.innerHTML = body.__full
        if (reply < 1) {
          const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          let left = Math.round(reply * body.__len)
          const texts = []
          while (walk.nextNode()) texts.push(walk.currentNode)
          for (const x of texts) {
            if (x.textContent.length > left) x.textContent = x.textContent.slice(0, left)
            left -= x.textContent.length
          }
          for (const blk of body.querySelectorAll('p, li')) if (!blk.textContent.trim()) blk.style.display = 'none'
        }
        const m = answer.querySelector('.easy-msg-meta')
        if (m) m.style.opacity = String(meta)
        const scroll = tr.querySelector('.easy-scroll')
        if (secs != null) {
          if (!working.isConnected) scroll.appendChild(working)
          working.querySelector('.easy-elapsed').textContent = `Working ${secs}s`
          const last = reply > 0 ? answer : steps > 0 ? rows[steps - 1] : tr.querySelector('.easy-msg.easy-user')
          const r = last.getBoundingClientRect()
          const sr = scroll.getBoundingClientRect()
          if (getComputedStyle(scroll).position === 'static') scroll.style.position = 'relative'
          const edge = answer.getBoundingClientRect().left - sr.left
          Object.assign(working.style, { position: 'absolute', left: `${edge}px`, right: '0', top: `${r.bottom - sr.top + scroll.scrollTop + 10}px` })
        } else working.remove()
      }
    })
    let st = { steps: 0, reply: 0, meta: 0, secs: 3 }
    const set = (p) => win.evaluate((s) => window.__build(s), (st = { ...st, ...p }))
    await set({})
    const cam = await camera(win, app, 'build', { composite: true })
    const tick = (s) => cam.seconds(s, (i) => (i % 30 === 0 ? set({ secs: st.secs + (i ? 1 : 0) }) : null))
    await tick(0.6)
    const url = `http://localhost:${shop.port}/`
    console.log(await tool('browser_navigate', { url }))
    await win.waitForTimeout(1500)
    await set({ steps: 1 })
    await tick(1.2)
    const box = await app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(url))
      return wc.executeJavaScript('(() => { const r = document.querySelector("input").getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })()')
    }, url)
    console.log(await tool('browser_click', box))
    await set({ steps: 2 })
    await tick(0.4)
    console.log(await tool('browser_type', { text: 'ana@example.com' }))
    await win.waitForTimeout(300)
    await set({ steps: 3 })
    await tick(0.8)
    console.log(await tool('browser_click', { text: 'Sign up' }))
    await win.waitForTimeout(400)
    await set({ steps: 4 })
    await tick(0.9)
    console.log(await tool('browser_set_viewport', { viewport: 'both' }))
    await win.waitForTimeout(2500)
    // The phone is a fresh page: sign it up too, so both show the same moment.
    await app.evaluate(async ({ webContents }, url) => {
      for (const wc of webContents.getAllWebContents()) if (wc.getURL().startsWith(url)) await wc.executeJavaScript('document.body.classList.add("done")')
    }, url)
    await set({ steps: 5 })
    await tick(0.5)
    await set({ steps: 6 })
    await tick(1.0)
    const F = 36
    await cam.run(F, (i) => set({ reply: (i + 1) / F }))
    await set({ secs: null })
    await cam.run(8, (i) => set({ meta: (i + 1) / 8 }))
    await cam.seconds(1.6)
    await cam.encode(cam.frames - 1)
  },

  // Windows joining a split one at a time; the others make room.
  async split({ win, app, ids }) {
    const c = ids.chats
    await open(win, c['Tighten the hero copy'].ws, c['Tighten the hero copy'].chat)
    await chrome(win)
    const beside = (title) =>
      win.evaluate(([ws, chat]) => window.__store.getState().openBeside(ws, chat), [c[title].ws, c[title].chat])
    const cam = await camera(win, app, 'split')
    await cam.seconds(0.8)
    await beside('Fix the flaky login test')
    await cam.seconds(1.0)
    await beside('Dark mode tokens')
    await cam.seconds(1.0)
    await beside('Export to Markdown')
    await cam.seconds(1.3)
    const busy = (title, on) =>
      win.evaluate(([id, on]) => window.__store.getState().setBusy(id, { generating: on, background: 0 }), [c[title].chat, on])
    await busy('Dark mode tokens', true)
    await busy('Fix the flaky login test', true)
    await cam.seconds(0.8)
    // Click one to talk to it.
    await win.click(`.workspace-view[data-desk="${c['Dark mode tokens'].chat}"] .tile-head`, { position: { x: 300, y: 12 } })
    // The pointer away again, so nothing is left hovered.
    await win.mouse.move(2, H - 2)
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await cam.seconds(1.8)
    await cam.encode(cam.frames - 1)
  },

  // The Routines window: a job typed in and added beside the ones already there.
  async routines({ win, app, ids }) {
    const { ws } = ids.chats['Fix the flaky login test']
    await open(win, ws, ids.chats['Fix the flaky login test'].chat)
    await win.evaluate(async ([ws, path]) => {
      await window.cove.routinesCreate(ws, path, 'Run the e2e suite against staging and tell me what broke', 24 * 60)
      await window.cove.routinesCreate(ws, path, 'Look for new crash reports in Sentry and sort them by how many people they hit', 60)
    }, [ws, join(root, 'mobile-app')])
    await chrome(win)
    const cam = await camera(win, app, 'routines')
    await cam.seconds(0.5)
    // View › Routines: the window opens on the desk.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:routines'))
    await win.waitForSelector('textarea.routine-prompt', { timeout: 5000 })
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await cam.seconds(1.0)
    const text = 'Check last night’s deploy and sum up what changed'
    const N = 42
    await cam.run(N, (i) =>
      win.evaluate((v) => {
        const ta = document.querySelector('textarea.routine-prompt')
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }, text.slice(0, Math.round((text.length * (i + 1)) / N)))
    )
    await win.selectOption('.routine-new-row select', '24')
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await cam.seconds(0.6)
    await win.click('.routine-add')
    await win.waitForTimeout(400)
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await cam.seconds(2.4)
    await cam.encode(cam.frames - 1)
  },

  // ⌘K: the palette opens and finds a conversation by a word in it.
  async keys({ win, app, ids }) {
    const c = ids.chats
    await open(win, c['Pricing page refresh'].ws, c['Pricing page refresh'].chat)
    await chrome(win)
    const cam = await camera(win, app, 'keys')
    await cam.seconds(0.6)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command-palette'))
    await win.waitForSelector('.cmdk-panel', { timeout: 5000 })
    await cam.seconds(0.8)
    const q = 'login'
    for (let i = 1; i <= q.length; i++) {
      await win.evaluate((v) => {
        const el = document.querySelector('.cmdk-input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }, q.slice(0, i))
      await win.waitForTimeout(200)
      await cam.run(4)
    }
    await win.waitForTimeout(600)
    await cam.seconds(1.6)
    await cam.encode(cam.frames - 1)
  }
}

// ---------- Run ----------

const dirs = Object.fromEntries(
  ['landing-page', 'shop-web', 'mobile-app', 'design-system', 'notes-app'].map((n) => [n, repo(n)])
)
const shop = await serveShop()
try {
  for (const name of only.length ? only : ['home', 'build', 'split', 'routines']) {
    const { app, win, userData, urlFile } = await launch()
    try {
      const ids = await seed(win, dirs)
      // The chat beside the browser takes this share of the window.
      await win.evaluate((id) => localStorage.setItem(`split:${id}`, '0.4'), ids.ws['shop-web'])
      await win.reload()
      await win.waitForSelector('.sidebar-item:has-text("landing-page")', { timeout: 20_000 })
      await scenes[name]({ app, win, ids, urlFile, shop })
    } finally {
      await app.close()
      rmSync(userData, { recursive: true, force: true })
    }
  }
} finally {
  shop.srv.close()
  rmSync(root, { recursive: true, force: true })
}
