import { describe, expect, it } from 'vitest'
import {
  LOOP_REPORT,
  loopActions,
  loopingDevices,
  parseSpringBoardCrash,
  type SpringBoardCrash
} from './crash-loop'

const NOW = Date.parse('2026-11-19T17:00:00Z')
const crash = (udid: string, agoSec: number): SpringBoardCrash => ({
  udid,
  at: NOW - agoSec * 1000,
  process: 'PosterBoard'
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
  it('reads the other system processes that loop: PosterBoard and backboardd', () => {
    expect(parseSpringBoardCrash(report({ procName: 'PosterBoard' }))?.udid).toBe(
      '71476563-1E9D-41C5-8A97-C81EABB49276'
    )
    expect(parseSpringBoardCrash(report({ procName: 'backboardd' }))).not.toBeNull()
    expect(LOOP_REPORT.test('PosterBoard-2026-11-28-142821.ips')).toBe(true)
    expect(LOOP_REPORT.test('SpringBoard-2026-11-22-140226.ips')).toBe(true)
    expect(LOOP_REPORT.test('MyApp-2026-11-28-142821.ips')).toBe(false)
  })
  it('ignores an app of its own, other coalitions and junk', () => {
    expect(parseSpringBoardCrash(report({ procName: 'MyApp' }))).toBeNull()
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

describe('loopActions: restart once, then shut it down', () => {
  const none = new Map<string, number>()
  const cs = [4, 9, 15].map((s) => crash('A', s))
  it('restarts a device that loops for the first time', () => {
    expect(loopActions(cs, NOW, none)).toEqual({ restart: ['A'], stop: [] })
  })
  it('shuts it down when it loops again after a restart, whoever owns it', () => {
    const restarted = new Map([['A', NOW - 2 * 60_000]])
    expect(loopActions(cs, NOW, restarted)).toEqual({ restart: [], stop: ['A'] })
  })
  it('leaves it down: no second stop, and nothing when it is quiet', () => {
    const restarted = new Map([['A', NOW - 2 * 60_000]])
    const stopped = new Map([['A', NOW - 30_000]])
    expect(loopActions(cs, NOW, restarted, stopped)).toEqual({ restart: [], stop: [] })
    expect(loopActions([], NOW, restarted)).toEqual({ restart: [], stop: [] })
  })
  it('does not stop a device whose crashes all came before its restart', () => {
    const restarted = new Map([['A', NOW - 1_000]])
    expect(loopActions(cs, NOW, restarted)).toEqual({ restart: [], stop: [] })
  })
})
