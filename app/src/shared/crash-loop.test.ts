import { describe, expect, it } from 'vitest'
import { loopingDevices, parseSpringBoardCrash, type SpringBoardCrash } from './crash-loop'

const NOW = Date.parse('2026-11-19T17:00:00Z')
const crash = (udid: string, agoSec: number): SpringBoardCrash => ({
  udid,
  at: NOW - agoSec * 1000
})
const report = (over: object): string =>
  `{"app_name":"SpringBoard"}\n${JSON.stringify({
    procName: 'SpringBoard',
    coalitionName: 'com.apple.CoreSimulator.SimDevice.71476563-1E9D-41C5-8A97-C81EABB49276',
    captureTime: '2026-11-19 17:59:33.7987 +0100',
    ...over
  })}`

describe('parseSpringBoardCrash', () => {
  it('reads the device and the time', () => {
    const c = parseSpringBoardCrash(report({}))!
    expect(c.udid).toBe('71476563-1E9D-41C5-8A97-C81EABB49276')
    expect(c.at).toBe(Date.parse('2026-11-19T16:59:33.798Z'))
  })
  it('ignores other processes, other coalitions and junk', () => {
    expect(parseSpringBoardCrash(report({ procName: 'backboardd' }))).toBeNull()
    expect(parseSpringBoardCrash(report({ coalitionName: 'com.apple.Safari' }))).toBeNull()
    expect(parseSpringBoardCrash('nope')).toBeNull()
    expect(parseSpringBoardCrash('{}\n{broken')).toBeNull()
  })
})

describe('loopingDevices', () => {
  const none = new Map<string, number>()
  it('flags a device that crashed three times in a minute and is still going', () => {
    const cs = [5, 11, 18].map((s) => crash('A', s))
    expect(loopingDevices(cs, NOW, none)).toEqual(['A'])
  })
  it('does not for two crashes, for old ones, or once it has gone quiet', () => {
    expect(
      loopingDevices(
        [5, 12].map((s) => crash('A', s)),
        NOW,
        none
      )
    ).toEqual([])
    expect(
      loopingDevices(
        [100, 110, 120, 130].map((s) => crash('A', s)),
        NOW,
        none
      )
    ).toEqual([])
    expect(
      loopingDevices(
        [30, 40, 50, 55].map((s) => crash('A', s)),
        NOW,
        none
      )
    ).toEqual([])
  })
  it('counts each device on its own', () => {
    const cs = [...[5, 12, 20].map((s) => crash('A', s)), crash('B', 5), crash('B', 10)]
    expect(loopingDevices(cs, NOW, none)).toEqual(['A'])
  })
  it('does not restart the same device again within ten minutes', () => {
    const cs = [5, 12, 20].map((s) => crash('A', s))
    expect(loopingDevices(cs, NOW, new Map([['A', NOW - 5 * 60_000]]))).toEqual([])
    expect(loopingDevices(cs, NOW, new Map([['A', NOW - 11 * 60_000]]))).toEqual(['A'])
  })
})
