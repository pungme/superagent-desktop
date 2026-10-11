import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: () => false }
}))
const store = vi.hoisted(() => ({ kv: {} as Record<string, string> }))
vi.mock('./store', () => ({
  kvGet: (k: string) => store.kv[k],
  kvSet: (k: string, v: string) => {
    store.kv[k] = v
  }
}))
const { applyBatteryFloor, installScript, RULE_PATH, safeUser, setLidAwake, sudoersRule } =
  await import('./lid-awake')

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

it('lets a closed Mac sleep under the battery floor, says so once, and holds it again once charged', async () => {
  store.kv['power.lidAwake'] = '1'
  store.kv['power.lidAwakeFloor'] = '20'
  const set: boolean[] = []
  const told: string[] = []
  const at = { onPower: false, percent: 50 }
  const run = (): Promise<void> =>
    applyBatteryFloor(
      async () => ({ ...at }),
      async (on) => {
        set.push(on)
        return true
      },
      (title) => told.push(title)
    )
  await run()
  expect(set).toEqual([])
  at.percent = 19
  await run()
  await run()
  expect(set).toEqual([false])
  expect(told).toEqual(['Your Mac will sleep when you close it'])
  // Charged a little: not yet. Past the floor and a bit: held again.
  at.percent = 22
  await run()
  expect(set).toEqual([false])
  at.percent = 26
  await run()
  expect(set).toEqual([false, true])
  expect(told).toHaveLength(2)
  delete store.kv['power.lidAwake']
})
