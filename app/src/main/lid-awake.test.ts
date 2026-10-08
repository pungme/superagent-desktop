import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./store', () => ({ kvGet: () => undefined, kvSet: vi.fn() }))
const { installScript, RULE_PATH, safeUser, setLidAwake, sudoersRule } = await import('./lid-awake')

it('grants this user the three exact commands and nothing wider', () => {
  const rule = sudoersRule('pungme')
  const line = rule.split('\n').find((l) => l.startsWith('pungme'))!
  expect(line).toBe(
    `pungme ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /bin/rm -f ${RULE_PATH}`
  )
  // No wildcards, no ALL commands.
  expect(line).not.toMatch(/\*|NOPASSWD:\s*ALL/)
})

it('will not write a user name that could change the meaning of the rule', () => {
  expect(safeUser('pungme')).toBe('pungme')
  expect(safeUser('first.last-2')).toBe('first.last-2')
  expect(safeUser('x ALL=(ALL) NOPASSWD: ALL')).toBeNull()
  expect(safeUser('a\nroot ALL=(ALL) ALL')).toBeNull()
  expect(safeUser('')).toBeNull()
})

it('checks the rule parses before putting it in place, with strict permissions', () => {
  const sh = installScript('pungme')
  expect(sh.indexOf('visudo -cf')).toBeGreaterThan(-1)
  expect(sh.indexOf('visudo -cf')).toBeLessThan(sh.indexOf('/usr/bin/install'))
  expect(sh).toContain(`-m 0440 -o root -g wheel`)
  expect(sh).toContain(RULE_PATH)
})

it('does nothing to the system from a test run', async () => {
  process.env.COVE_USER_DATA = '/tmp/x'
  expect(await setLidAwake(true)).toMatchObject({ ok: false })
  delete process.env.COVE_USER_DATA
})
