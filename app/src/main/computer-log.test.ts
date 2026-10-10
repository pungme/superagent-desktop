import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'cove-culog-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
const { noteComputer, parseLog, recentComputerLog } = await import('./computer-log')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the record of what was done with the Mac', () => {
  it('keeps each thing with when, in which conversation and in which app, newest first', () => {
    noteComputer({ owner: 'c1', what: 'Looked at the screen', kind: 'looked', at: 1000 })
    noteComputer({ owner: 'c1', what: 'Pressed "Save"', app: 'TextEdit', at: 2000 })
    noteComputer({ owner: 'c2', what: 'Typed 12 characters', app: 'Notes', at: 3000 })
    const log = recentComputerLog()
    expect(log.map((e) => e.what)).toEqual([
      'Typed 12 characters',
      'Pressed "Save"',
      'Looked at the screen'
    ])
    expect(log[1]).toEqual({
      at: 2000,
      owner: 'c1',
      what: 'Pressed "Save"',
      app: 'TextEdit',
      kind: 'did'
    })
    expect(recentComputerLog(1)).toHaveLength(1)
  })
  it('survives a line cut short by a crash', () => {
    expect(parseLog('{"at":1,"owner":"a","what":"x"}\n{"at":2,"own')).toEqual([
      { at: 1, owner: 'a', what: 'x' }
    ])
  })
  it('does not grow for ever', () => {
    const many = Array.from({ length: 3500 }, (_, i) =>
      JSON.stringify({ at: i, owner: 'c', what: `step ${i}` })
    )
    writeFileSync(join(dir, 'computer-use.log.jsonl'), many.join('\n') + '\n')
    expect(recentComputerLog(1)[0].what).toBe('step 3499')
    expect(
      readFileSync(join(dir, 'computer-use.log.jsonl'), 'utf8').trim().split('\n')
    ).toHaveLength(2000)
  })
})
