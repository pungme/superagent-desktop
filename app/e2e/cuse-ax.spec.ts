import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test'
import { spawn, spawnSync, ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Acting on a control by its name, through accessibility: press a button, put
 * text in a field, pick a menu item. Against a tiny app of the test's own
 * whose window is far off every screen and never comes to the front, so
 * nothing shows, nothing takes focus and the pointer does not move. The helper
 * only acts when the app itself runs it, so it is run from the app.
 */

const helper = join(__dirname, '..', 'native', 'cuse')
let app: ElectronApplication
let target: ChildProcess
let dir: string
let data: string
let log = ''
let pid = 0

const cuse = (...args: string[]): Promise<Record<string, unknown>> =>
  app.evaluate(
    (_e, [bin, argv]) => {
      const { execFileSync } = (
        process as unknown as { getBuiltinModule: (n: string) => Record<string, never> }
      ).getBuiltinModule('child_process') as unknown as {
        execFileSync: (b: string, a: string[], o: { encoding: 'utf8' }) => string
      }
      try {
        return JSON.parse(execFileSync(bin as string, argv as string[], { encoding: 'utf8' }))
      } catch (e) {
        return JSON.parse(String((e as { stdout?: string }).stdout || '{"ok":false}'))
      }
    },
    [helper, args] as const
  )

type Control = { i: number; role: string; label: string; value: string }
const controls = async (): Promise<Control[]> =>
  ((await cuse('--pid', String(pid), 'ax', '60')) as { elements: Control[] }).elements

test.beforeAll(async () => {
  const clang = spawnSync('/usr/bin/clang', ['--version'])
  test.skip(
    process.platform !== 'darwin' || clang.status !== 0 || !existsSync(helper),
    'needs a Mac, clang and the built helper'
  )
  dir = mkdtempSync(join(tmpdir(), 'cove-ax-'))
  data = mkdtempSync(join(tmpdir(), 'cove-ax-data-'))
  const built = spawnSync('/usr/bin/clang', [
    '-fobjc-arc',
    '-framework',
    'Cocoa',
    '-o',
    join(dir, 'ax-target'),
    join(__dirname, 'fixtures', 'ax-target.m')
  ])
  expect(built.status, String(built.stderr)).toBe(0)
  target = spawn(join(dir, 'ax-target'))
  target.stdout!.on('data', (d) => (log += String(d)))
  await expect.poll(() => /READY pid=(\d+)/.exec(log)?.[1] ?? '').not.toBe('')
  pid = Number(/READY pid=(\d+)/.exec(log)![1])
  const proj = join(dir, 'proj')
  spawnSync('/bin/mkdir', ['-p', proj])
  writeFileSync(join(proj, 'README.md'), '# x\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  await app.firstWindow()
})

test.afterAll(async () => {
  target?.kill()
  await app?.close()
  for (const d of [dir, data]) if (d) rmSync(d, { recursive: true, force: true })
})

test('the controls of an app are listed by name, a password never read', async () => {
  const list = await controls()
  const by = (label: string): Control => list.find((c) => c.label === label)!
  expect(by('Press').role).toBe('Button')
  expect(by('Name').role).toBe('TextField')
  expect(by('Password')).toMatchObject({ role: 'SecureTextField', value: '(hidden)' })
  expect(JSON.stringify(list)).not.toContain('hunter2')
})

test('a button is pressed by its name, with the app staying in the background', async () => {
  const press = (await controls()).find((c) => c.label === 'Press')!
  expect(await cuse('--pid', String(pid), 'axpress', String(press.i), 'Press')).toMatchObject({
    ok: true
  })
  await expect.poll(() => log).toContain('PRESSED active=0')
})

test('nothing is pressed when the control is no longer the one that was read', async () => {
  const press = (await controls()).find((c) => c.label === 'Press')!
  const before = (log.match(/PRESSED/g) ?? []).length
  expect(await cuse('--pid', String(pid), 'axpress', String(press.i), 'Delete everything')).toEqual(
    {
      ok: false,
      error: 'the controls have changed since they were read'
    }
  )
  expect(await cuse('--pid', String(pid), 'axpress', '999', 'Press')).toMatchObject({ ok: false })
  expect((log.match(/PRESSED/g) ?? []).length).toBe(before)
})

test('text is put in a field by its name, and never in a password field', async () => {
  const list = await controls()
  const name = list.find((c) => c.label === 'Name')!
  const secret = list.find((c) => c.label === 'Password')!
  expect(
    await cuse('--pid', String(pid), 'axset', String(name.i), 'Name', 'Ada Lovelace')
  ).toMatchObject({ ok: true })
  await expect.poll(() => log).toContain('FIELD Ada Lovelace')
  expect(await cuse('--pid', String(pid), 'axset', String(secret.i), 'Password', 'guess')).toEqual({
    ok: false,
    error: 'that is a password field'
  })
  await new Promise((r) => setTimeout(r, 400))
  expect(log.split('\n').filter(Boolean).pop()).toContain('SECRET hunter2')
})

test('a menu item is picked by its path; a greyed one, or one that is not there, is not', async () => {
  expect(await cuse('--pid', String(pid), 'axmenu', 'File > Ping')).toMatchObject({ ok: true })
  await expect.poll(() => log).toContain('MENU ping')
  expect(await cuse('--pid', String(pid), 'axmenu', 'File>Greyed')).toEqual({
    ok: false,
    error: 'that menu item is greyed out'
  })
  expect(await cuse('--pid', String(pid), 'axmenu', 'File>Nope')).toMatchObject({ ok: false })
})
