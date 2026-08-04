// Screenshot driver: connects to the running dev app over CDP and performs one
// named step per invocation, so each stage can be inspected before the next.
import { chromium } from 'playwright-core'

const step = process.argv[2]
const arg = process.argv[3]
const out = process.argv[4]

const browser = await chromium.connectOverCDP('http://localhost:9222')
// Identify the renderer by its preload bridge, not by URL: a previewed local file
// is itself an index.html, so a URL match can pick the page being previewed.
const allPages = browser.contexts().flatMap((c) => c.pages())
const page = (
  await Promise.all(
    allPages.map(async (p) => ((await p.evaluate(() => !!window.cove).catch(() => false)) ? p : null))
  )
).find(Boolean)
if (!page) throw new Error('app page not found')

const wait = (ms) => page.waitForTimeout(ms)

// Every opened workspace stays mounted — hidden ones are display:none — so a bare
// querySelector regularly returns an element belonging to a workspace that isn't on
// screen. Everything below scopes to the visible one.
await page.addInitScript(() => {})
await page.evaluate(() => {
  window.__visibleHost = () =>
    [...document.querySelectorAll('.workspace-host')].find((h) => h.offsetParent !== null) || null
  window.__visibleIn = (sel) => {
    const host = window.__visibleHost()
    const scope = host || document
    return [...scope.querySelectorAll(sel)].find((el) => el.offsetParent !== null) || null
  }
})

if (step === 'dismiss-onboarding') {
  await page.click("text=Let's go").catch((e) => console.error('lets-go:', e.message))
  await wait(1200)
} else if (step === 'seed') {
  const DEMO = arg
  await page.evaluate(async (DEMO) => {
    const cove = window.cove
    const gid = async (name) => {
      const tree = await cove.createGroup(name)
      return tree[tree.length - 1].id
    }
    const browsing = await gid('Browsing')
    const work = await gid('Work')
    const personal = await gid('Personal')
    const side = await gid('Side projects')

    const b1 = await cove.createBrowserWorkspace(browsing, 'Browser project')
    await cove.updateWorkspace(b1.workspaceId, {
      browserUrl: 'https://en.wikipedia.org/wiki/Web_browser'
    })
    const b2 = await cove.createBrowserWorkspace(browsing, 'Browser project')
    await cove.updateWorkspace(b2.workspaceId, { browserUrl: 'https://news.ycombinator.com/' })

    const mk = (g, n) => cove.createWorkspace(g, n, `${DEMO}/${n}`)
    await mk(work, 'mobile-app')
    await mk(work, 'landing-page')
    await mk(work, 'design-system')
    await mk(work, 'notes-app')
    await mk(personal, 'shop-web')
    await mk(side, 'toolkit')
    await mk(side, 'docs-site')
  }, DEMO)
  await page.reload()
  await wait(3500)
} else if (step === 'click') {
  await page.click(`text=${arg}`)
  await wait(3000)
} else if (step === 'type') {
  // Type into the chat composer and send.
  // Every opened workspace stays mounted, so several composers exist; only the
  // active workspace's is visible.
  const box = page.locator('textarea:visible').first()
  await box.click()
  await box.fill('')
  await page.keyboard.type(arg, { delay: 12 })
  await page.keyboard.press('Enter')
  await wait(2000)
} else if (step === 'wait') {
  await wait(Number(arg))
} else if (step === 'scroll-chat') {
  // arg: 'top' | 'bottom' | a pixel offset from the top of the transcript.
  await page.evaluate((where) => {
    const el = window.__visibleIn('.easy-scroll') || window.__visibleIn('.easy-messages')
    if (!el) return
    if (where === 'top') el.scrollTop = 0
    else if (where === 'bottom') el.scrollTop = el.scrollHeight
    else el.scrollTop = Number(where)
  }, arg)
  await wait(600)
} else if (step === 'pane-goto') {
  // Drive the native browser pane's own target directly.
  // Target the pane of the workspace on screen, not just the first one open.
  const activeUrl = await page.evaluate(() => {
    const input = [...document.querySelectorAll('.browser-address')].find(
      (el) => el.offsetParent !== null
    )
    return input ? input.value : null
  })
  const norm = (u) => u.replace(/\/$/, '')
  const pane = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find(
      (p) =>
        p !== page &&
        !p.url().startsWith('devtools://') &&
        activeUrl &&
        (norm(p.url()) === norm(activeUrl) || p.url().startsWith(activeUrl))
    )
  if (!pane) throw new Error('no pane target for active workspace: ' + activeUrl)
  await pane.goto(arg, { waitUntil: 'load' })
  await pane.waitForTimeout(2500)
} else if (step === 'wait-for') {
  await page.waitForSelector(arg, { timeout: 120000 }).catch((e) => console.error('wait-for:', e.message))
} else if (step === 'expand-steps') {
  // The collapsed "N steps …" summary row — opening it shows the individual calls.
  // arg picks which group when a turn has several; default is the last.
  await page
    .evaluate((which) => {
      const host = window.__visibleHost()
      const all = [...(host || document).querySelectorAll('.easy-tools-toggle')]
      const el = which === 'first' ? all[0] : all[all.length - 1]
      el?.click()
    }, arg)
    .catch((e) => console.error('expand:', e.message))
  await wait(800)
} else if (step === 'clear-composer') {
  // Via the keyboard so React's state clears too — setting .value directly wouldn't.
  await page.locator('textarea:visible').first().click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await wait(300)
} else if (step === 'blur') {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await wait(300)
} else if (step === 'eval') {
  console.log(JSON.stringify(await page.evaluate(arg)))
}

if (out) {
  await page.bringToFront()
  await page.screenshot({ path: out })
  console.log('saved', out)
}
console.log('step done:', step)
await browser.close()
