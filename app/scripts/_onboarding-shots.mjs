// Screenshot driver: walks the first-run flow (intro reel → probe → welcome
// card in each of its states → the app) against a throwaway userData dir, with
// the agent probe stubbed in main so every state is reachable on a Mac that
// already has Claude Code. Quiet: no window, Dock icon or focus (main/quiet.ts).
//
//   npm run build && node scripts/_onboarding-shots.mjs [outDir]
import { _electron as electron } from 'playwright-core'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const here = dirname(fileURLToPath(import.meta.url))
// Not test-results/: Playwright empties that on every run.
const out = resolve(process.argv[2] || join(tmpdir(), 'superagent-onboarding-shots'))
mkdirSync(out, { recursive: true })
const dir = mkdtempSync(join(tmpdir(), 'cove-onboarding-shots-'))

const app = await electron.launch({
  args: [join(here, '..', 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    COVE_E2E_QUIET: '1',
    COVE_USER_DATA: dir,
    COVE_E2E_INTRO: '1',
    NODE_ENV: 'production'
  }
})

const provider = (installed, loggedIn, version) => ({
  installed,
  loggedIn,
  version: installed ? version : null
})
const env = (claude, codex) => ({
  claude,
  codex,
  claudeInstalled: claude.installed,
  claudeVersion: claude.version,
  loggedIn: (claude.installed && claude.loggedIn) || (codex.installed && codex.loggedIn)
})
const NONE = env(provider(false, false), provider(false, false))
const INSTALLED = env(provider(true, false, '2.1.283'), provider(false, false))
const READY = env(provider(true, true, '2.1.283'), provider(false, false))

const setEnv = (status, delay = 0) =>
  app.evaluate((_e, [s, d]) => {
    globalThis.__env = s
    globalThis.__envDelay = d
  }, [status, delay])

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const shot = async (name) => {
    await page.screenshot({ path: join(out, `${name}.png`) })
    console.log(name)
  }

  // Answer the probe, the installer and the sign-in from here: no real CLI
  // call, no download, no Terminal window.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('env:detect')
    ipcMain.handle('env:detect', async () => {
      await new Promise((r) => setTimeout(r, globalThis.__envDelay || 0))
      return globalThis.__env
    })
    ipcMain.removeHandler('env:install')
    ipcMain.handle(
      'env:install',
      (e) =>
        new Promise((done) => {
          e.sender.send('env:install-progress', 'Installing Claude Code native build latest…')
          globalThis.__finishInstall = done
        })
    )
    ipcMain.removeAllListeners('env:open-login')
  })

  // 1. The intro reel, over the app, on a brand-new install.
  await setEnv(NONE)
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload()
  await page.waitForSelector('.first-run-intro iframe', { timeout: 10_000 })
  for (let i = 1; i <= 20; i++) {
    await page.waitForTimeout(i === 1 ? 1200 : 2500)
    if ((await page.locator('.first-run-intro').count()) === 0) break
    await shot(`1-intro-${String(i).padStart(2, '0')}`)
  }
  await page.waitForSelector('.first-run-intro', { state: 'detached', timeout: 40_000 })

  // 3. The welcome card: nothing installed.
  await page.waitForSelector('.onboarding-card')
  await page.waitForTimeout(800)
  await shot('3-welcome-nothing-installed')

  // 4. Installing, then an install that failed.
  await page.locator('.onboarding-install-btn', { hasText: 'Install' }).first().click()
  await page.waitForSelector('.onboarding-install-progress')
  await page.waitForTimeout(400)
  await shot('4-installing')
  await app.evaluate(() =>
    globalThis.__finishInstall({ ok: false, error: 'curl: (6) Could not resolve host: claude.ai' })
  )
  await page.waitForSelector('.onboarding-install-error')
  await shot('5-install-failed')

  // 6. Installed, not signed in.
  await setEnv(INSTALLED)
  await page.click('.onboarding-recheck')
  await page.waitForSelector('.onboarding-install-btn:has-text("Sign in")')
  await shot('6-installed-sign-in')

  // 7. One agent ready.
  await setEnv(READY)
  await page.click('.onboarding-recheck')
  await page.waitForSelector('.onboarding-agent-badge')
  await shot('7-ready')

  // 8. Into the app.
  await page.click('.onboarding-continue')
  await page.waitForSelector('.sidebar', { timeout: 20_000 })
  await page.waitForTimeout(1200)
  await shot('8-app-first-screen')

  // 2. What sits under the intro while the probe runs (seen when the intro is
  // skipped early, or doesn't play): taken last, with the intro already seen.
  await setEnv(NONE, 15_000)
  await page.evaluate(() => localStorage.removeItem('cove.onboarded'))
  await page.reload()
  await page.waitForSelector('.onboarding-waiting')
  await page.waitForTimeout(1500)
  await shot('2-getting-things-ready')
} finally {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
}
