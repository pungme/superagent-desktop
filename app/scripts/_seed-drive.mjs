import { chromium } from 'playwright-core'

const DEMO = process.argv[2]
const NIMBUS = process.argv[3] // file:// url for the nimbus demo
const mode = process.argv[4] || 'seed' // 'seed' | 'open-wiki' | 'open-nimbus'

const browser = await chromium.connectOverCDP('http://localhost:9222')
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes('index.html'))
if (!page) throw new Error('app page not found')

if (mode === 'seed') {
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
  await page.waitForTimeout(3500)
  console.log('seeded')
} else if (mode === 'open-wiki') {
  // Click the first browser project (shows its host) to open its pane → navigates
  // to the seeded Wikipedia URL in Desktop viewport (the docked-omnibar card).
  await page.click('text=en.wikipedia.org').catch((e) => console.error('click', e.message))
  await page.waitForTimeout(5000)
  console.log('opened wiki')
} else if (mode === 'open-nimbus') {
  // Point the first browser project at the local Nimbus demo and open it.
  await page.evaluate(async (url) => {
    const s = await import('/state-noop').catch(() => null)
    void s
    // Navigate the active pane via the omnibox is unreliable headless; use IPC:
    const tree = await window.cove.storeTree()
    const bw = tree.flatMap((g) => g.workspaces).find((w) => w.kind === 'browser')
    if (bw) {
      await window.cove.updateWorkspace(bw.id, { browserUrl: url })
    }
  }, NIMBUS)
  await page.click('text=en.wikipedia.org').catch(() => {})
  await page.waitForTimeout(1500)
  await page.evaluate((url) => {
    const tree = window.cove
    void tree
  }, NIMBUS)
  await page.waitForTimeout(3000)
  console.log('opened nimbus')
}
await browser.close()
