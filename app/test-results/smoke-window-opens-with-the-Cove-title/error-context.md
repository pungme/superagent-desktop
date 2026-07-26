# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> window opens with the Cove title
- Location: e2e/smoke.spec.ts:49:5

# Error details

```
"beforeAll" hook timeout of 60000ms exceeded.
```

# Test source

```ts
  1  | import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
  2  | import { join } from 'path'
  3  | import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
  4  | import { tmpdir } from 'os'
  5  | 
  6  | /**
  7  |  * End-to-end smoke suite. Launches the built Electron app against a throwaway
  8  |  * userData dir and a seeded test project, so it needs no native dialogs and
  9  |  * leaves the user's real config untouched.
  10 |  *
  11 |  * Prereq: `npm run build` (produces out/main/index.js).
  12 |  */
  13 | 
  14 | let app: ElectronApplication
  15 | let window: Page
  16 | let userDataDir: string
  17 | let projectDir: string
  18 | 
> 19 | test.beforeAll(async () => {
     |      ^ "beforeAll" hook timeout of 60000ms exceeded.
  20 |   userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-data-'))
  21 |   projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-proj-'))
  22 |   mkdirSync(projectDir, { recursive: true })
  23 |   writeFileSync(join(projectDir, 'README.md'), '# e2e project\n')
  24 | 
  25 |   app = await electron.launch({
  26 |     args: [join(__dirname, '..', 'out', 'main', 'index.js')],
  27 |     env: {
  28 |       ...process.env,
  29 |       COVE_USER_DATA: userDataDir,
  30 |       COVE_E2E_PROJECT: projectDir,
  31 |       NODE_ENV: 'production'
  32 |     }
  33 |   })
  34 |   window = await app.firstWindow()
  35 |   await window.waitForLoadState('domcontentloaded')
  36 | })
  37 | 
  38 | test.afterAll(async () => {
  39 |   await app?.close()
  40 |   for (const dir of [userDataDir, projectDir]) {
  41 |     try {
  42 |       rmSync(dir, { recursive: true, force: true })
  43 |     } catch {
  44 |       // best effort
  45 |     }
  46 |   }
  47 | })
  48 | 
  49 | test('window opens with the Cove title', async () => {
  50 |   expect(await window.title()).toBe('Cove')
  51 | })
  52 | 
  53 | test('onboarding renders, then the main app loads with the seeded workspace', async () => {
  54 |   // Onboarding shows first; skip it deterministically.
  55 |   await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  56 |   await window.reload()
  57 |   await window.waitForSelector('.sidebar', { timeout: 20_000 })
  58 | 
  59 |   // Seeded group + workspace are present.
  60 |   await expect(window.locator('.sidebar-group-title')).toContainText('My projects')
  61 |   await expect(window.locator('.sidebar-item-name')).toContainText('e2e-project')
  62 | })
  63 | 
  64 | test('opening the workspace shows the mode switch and toolbar actions', async () => {
  65 |   await window.click('.sidebar-item:has-text("e2e-project")')
  66 |   await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
  67 |   await expect(window.locator('.mode-switch')).toBeVisible()
  68 |   await expect(window.locator('.toolbar-btn:has-text("Routines")')).toBeVisible()
  69 |   await expect(window.locator('.toolbar-btn:has-text("Skills")')).toBeVisible()
  70 | })
  71 | 
  72 | test('the browser preview pane can be toggled on', async () => {
  73 |   await window.click('.toolbar-btn:has-text("Show preview")')
  74 |   await window.waitForSelector('.browser-pane', { timeout: 10_000 })
  75 |   await expect(window.locator('.browser-address')).toBeVisible()
  76 | })
  77 | 
  78 | test('the Settings panel opens from the sidebar gear', async () => {
  79 |   await window.click('.sidebar-settings')
  80 |   await window.waitForSelector('.settings-panel', { timeout: 5_000 })
  81 |   await expect(window.locator('.settings-panel')).toContainText('Settings')
  82 |   await window.click('.skills-close')
  83 | })
  84 | 
```