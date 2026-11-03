import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * "+ Add skill" in the Skills panel: from a folder and from a zip, into a
 * temporary HOME (never the real one), then listed, offered in "/", and
 * removable. The picker is answered through COVE_E2E_PICK_SKILL, a file the
 * test writes the chosen path into. No network: links are covered by the unit
 * tests with a fake download.
 */

let app: ElectronApplication
let window: Page
let root: string
let home: string
let pickFile: string
const shots = process.env.SKILLS_SHOTS

const pick = (path: string): void => writeFileSync(pickFile, path)

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cove-e2e-skills-add-'))
  home = join(root, 'home')
  const userData = join(root, 'data')
  const project = join(root, 'e2e-project')
  for (const d of [home, userData, project]) mkdirSync(d, { recursive: true })
  writeFileSync(join(project, 'README.md'), '# e2e project\n')
  pickFile = join(root, 'pick.txt')

  // A folder skill with a script in it.
  const folder = join(root, 'src', 'deploy-check')
  mkdirSync(join(folder, 'scripts'), { recursive: true })
  writeFileSync(
    join(folder, 'SKILL.md'),
    '---\nname: deploy-check\ndescription: Check the deploy is healthy\n---\n\nRun scripts/check.sh.\n'
  )
  writeFileSync(join(folder, 'scripts', 'check.sh'), '#!/bin/sh\necho ok\n')

  // A zip with a wrapper folder and a plain skill inside.
  const zipSrc = join(root, 'zipsrc', 'pack', 'tidy-notes')
  mkdirSync(zipSrc, { recursive: true })
  writeFileSync(
    join(zipSrc, 'SKILL.md'),
    '---\nname: tidy-notes\ndescription: Tidy up meeting notes\n---\n\nTidy them.\n'
  )
  execFileSync('/usr/bin/zip', ['-qr', join(root, 'tidy-notes.zip'), 'pack'], {
    cwd: join(root, 'zipsrc')
  })

  // A skill on the claude.ai account, as Claude Code syncs it.
  const synced = join(home, '.claude', 'skills', 'synced', 'org_user', 'instantly-outreach')
  mkdirSync(synced, { recursive: true })
  writeFileSync(
    join(synced, 'SKILL.md'),
    '---\nname: instantly-outreach\ndescription: Set up a creator campaign in Instantly\n---\n'
  )

  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      HOME: home,
      COVE_USER_DATA: userData,
      COVE_E2E_PROJECT: project,
      COVE_E2E_PICK_SKILL: pickFile,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    await window.cove.chatCreate(ws.id)
    localStorage.setItem('cove.onboarded', '1')
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(window.getByRole('textbox', { name: /Message Claude/ })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

const panel = (): ReturnType<Page['locator']> => window.locator('.section-embedded')
const openSkills = async (): Promise<void> => {
  await window.evaluate(() => window.dispatchEvent(new Event('cove:open-skills')))
  await expect(panel().locator('.skills-footer')).toBeVisible()
}
const card = (name: string): ReturnType<Page['locator']> =>
  panel().locator('.skill-card', {
    has: window.locator('.skill-name', { hasText: new RegExp(`^${name}$`) })
  })

test('Skills is a section of Settings, opened from View › Skills', async () => {
  await openSkills()
  await expect(window.locator('.settings-nav-item.on')).toHaveText('Skills')
  await expect(window.locator('.settings-page h2', { hasText: 'Skills' })).toBeVisible()
  // The claude.ai account's skills are there already, marked so, and changed on claude.ai.
  const synced = card('instantly-outreach')
  await expect(synced.locator('.skill-scope')).toHaveText('claude.ai')
  await expect(synced.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  await window.locator('.settings-page').screenshot({ path: 'test-results/settings-skills.png' })
})

test('adds a skill from a folder, warning about its script', async () => {
  await openSkills()
  pick(join(root, 'src', 'deploy-check'))
  await panel().getByRole('button', { name: '+ Add skill' }).click()
  const menu = panel().locator('.skills-add-menu')
  await expect(menu.getByRole('menuitem')).toHaveText([
    'From a folder…',
    'From a .zip or .skill file…',
    'From a link…'
  ])
  if (shots) await window.screenshot({ path: join(shots, '1-add-menu.png') })
  await menu.getByRole('menuitem', { name: 'From a folder…' }).click()

  const sheet = panel().locator('.skill-sheet')
  await expect(sheet.locator('.skill-sheet-title')).toHaveText('Add skill to Claude Code')
  await expect(sheet).toContainText('deploy-check')
  await expect(sheet.locator('.skill-sheet-warning')).toHaveText(
    'This skill includes scripts the agent can run. Install only skills you trust.'
  )
  await expect(sheet.getByRole('radio', { name: 'All projects' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  if (shots) await window.screenshot({ path: join(shots, '2-script-warning.png') })
  await sheet.getByRole('button', { name: 'Install' }).click()

  await expect(sheet).toHaveCount(0)
  await expect(card('deploy-check')).toBeVisible()
  // Into the temporary home's Claude folder, files and all.
  const dir = join(home, '.claude', 'skills', 'deploy-check')
  expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('Check the deploy is healthy')
  expect(existsSync(join(dir, 'scripts', 'check.sh'))).toBe(true)
})

test('adds a skill from a zip into this project, then asks when the name is taken', async () => {
  pick(join(root, 'tidy-notes.zip'))
  await panel().getByRole('button', { name: '+ Add skill' }).click()
  await panel().getByRole('menuitem', { name: 'From a .zip or .skill file…' }).click()
  const sheet = panel().locator('.skill-sheet')
  await expect(sheet).toContainText('tidy-notes')
  await expect(sheet.locator('.skill-sheet-warning')).toHaveCount(0)
  await sheet.getByRole('radio', { name: 'This project' }).click()
  await sheet.getByRole('button', { name: 'Install' }).click()
  await expect(card('tidy-notes')).toContainText('project')
  expect(existsSync(join(root, 'e2e-project', '.claude', 'skills', 'tidy-notes', 'SKILL.md'))).toBe(
    true
  )

  // The same zip again: Replace / Keep both / Cancel.
  await panel().getByRole('button', { name: '+ Add skill' }).click()
  await panel().getByRole('menuitem', { name: 'From a .zip or .skill file…' }).click()
  await sheet.getByRole('radio', { name: 'This project' }).click()
  await expect(sheet).toContainText('A skill named “tidy-notes” is already there.')
  await expect(sheet.locator('.skill-sheet-buttons button')).toHaveText([
    'Cancel',
    'Keep both',
    'Replace'
  ])
  if (shots) await window.screenshot({ path: join(shots, '3-name-taken.png') })
  await sheet.getByRole('button', { name: 'Keep both' }).click()
  await expect(card('tidy-notes-2')).toBeVisible()
  await expect(card('tidy-notes')).toBeVisible()
})

test('a new skill is offered in "/" in the composer', async () => {
  await window.click('.sidebar-item:has-text("e2e-project")')
  const box = window.getByRole('textbox', { name: /Message Claude/ })
  await box.click()
  await box.fill('/tidy')
  await expect(
    window.locator('.easy-mention-menu .easy-mention-name', { hasText: '/tidy-notes-2' })
  ).toBeVisible()
  await box.fill('')
})

test('Remove asks first, then takes the skill out', async () => {
  await openSkills()
  await card('tidy-notes-2').hover()
  await card('tidy-notes-2').getByRole('button', { name: 'Remove' }).click()
  const sheet = panel().locator('.skill-sheet')
  await expect(sheet.locator('.skill-sheet-title')).toHaveText('Move “tidy-notes-2” to the Trash?')
  if (shots) await window.screenshot({ path: join(shots, '4-remove.png') })
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(card('tidy-notes-2')).toBeVisible()

  await card('tidy-notes-2').hover()
  await card('tidy-notes-2').getByRole('button', { name: 'Remove' }).click()
  await sheet.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(card('tidy-notes-2')).toHaveCount(0)
  await expect(card('tidy-notes')).toBeVisible()
  expect(existsSync(join(root, 'e2e-project', '.claude', 'skills', 'tidy-notes-2'))).toBe(false)
})
