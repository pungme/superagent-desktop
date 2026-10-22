import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'

vi.mock('./store', () => ({ getChat: () => null }))
vi.mock('./simulator', () => ({
  chatHoldingSimulator: () => null,
  noteSimulatorUsed: () => {},
  simulatorsByChat: () => new Map(),
  knownDeviceNames: () => new Map()
}))
const { simShellVerdict } = await import('./sim-guard')

const MINE = 'E75F9DC1-0BE8-4AB1-8D4F-500A6F08B66A'
const THEIRS = '518AC69A-303D-4357-9FE7-7FEAA4E4E84B'
const who = {
  mine: MINE,
  takenBy: (u: string) => (u.toUpperCase() === THEIRS ? 'Fix the login page' : null)
}
const nobody = { mine: null, takenBy: () => null }

describe("a conversation's shell and the simulators", () => {
  /** 2026-10-22: `./ios-run.sh <UDID>` installed onto another conversation's device. */
  it("stops a script given another conversation's simulator, not only simctl", () => {
    const why = simShellVerdict(`.agent-helpers/ios-run.sh ${THEIRS} testStart`, who)
    expect(why).toContain('Fix the login page')
    expect(simShellVerdict(`U=${THEIRS}; ./run.sh $U`, who)).toContain('Fix the login page')
    // Its own device, or one nobody has, is fine.
    expect(simShellVerdict(`.agent-helpers/ios-run.sh ${MINE} testStart`, who)).toBeNull()
    expect(simShellVerdict(`./ios-run.sh ${THEIRS}`, nobody)).toBeNull()
    // Only looking at someone else's is still allowed.
    expect(simShellVerdict(`xcrun simctl io ${THEIRS} screenshot /tmp/x.png`, who)).toBeNull()
  })

  it('leaves commands that have nothing to do with a simulator alone', () => {
    expect(simShellVerdict('npm test', who)).toBeNull()
    expect(simShellVerdict('xcodebuild -scheme App build', who)).toBeNull()
  })

  /** The bug: an install onto the device another conversation is testing on. */
  it("stops a command aimed at another conversation's simulator", () => {
    const why = simShellVerdict(`xcrun simctl install ${THEIRS} build/App.app`, who)
    expect(why).toContain('Fix the login page')
    expect(why).toContain(MINE)
    expect(
      simShellVerdict(
        `xcodebuild test -scheme App -destination "platform=iOS Simulator,id=${THEIRS.toLowerCase()}"`,
        who
      )
    ).toContain('in use by')
  })

  /** A screenshot or a listing of someone else's device disturbs nothing. */
  it("lets a command that only looks at another conversation's simulator through", () => {
    expect(simShellVerdict(`xcrun simctl io ${THEIRS} screenshot /tmp/a.png`, who)).toBeNull()
    expect(simShellVerdict(`xcrun simctl io ${THEIRS} enumerate`, who)).toBeNull()
    expect(simShellVerdict(`xcrun simctl listapps ${THEIRS}`, who)).toBeNull()
    // But not when the same line also changes it.
    expect(
      simShellVerdict(
        `xcrun simctl io ${THEIRS} screenshot /tmp/a.png && xcrun simctl terminate ${THEIRS} com.x`,
        who
      )
    ).toContain('in use by')
  })

  it('lets a command aimed at its own simulator through', () => {
    expect(simShellVerdict(`xcrun simctl install ${MINE} build/App.app`, who)).toBeNull()
    expect(
      simShellVerdict(
        `xcodebuild test -scheme App -destination 'platform=iOS Simulator,id=${MINE}'`,
        who
      )
    ).toBeNull()
  })

  it('does not let `booted` stand for a device', () => {
    expect(simShellVerdict('xcrun simctl install booted build/App.app', who)).toContain(MINE)
    expect(
      simShellVerdict('cd ios && xcrun simctl launch booted com.example.app', nobody)
    ).toContain('sim_list_devices')
    // Looking is harmless.
    expect(simShellVerdict('xcrun simctl list devices booted', who)).toBeNull()
    expect(simShellVerdict('xcrun simctl list devices | grep Booted', who)).toBeNull()
  })

  it('wants a destination by UDID, not by name', () => {
    const why = simShellVerdict(
      "xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 17e'",
      who
    )
    expect(why).toContain('id=<UDID>')
    expect(why).toContain(MINE)
    // A build for no device in particular installs nothing.
    expect(
      simShellVerdict(
        "xcodebuild build -scheme App -destination 'generic/platform=iOS Simulator'",
        who
      )
    ).toBeNull()
    // A Mac or a real phone is not a simulator.
    expect(
      simShellVerdict("xcodebuild test -scheme App -destination 'platform=macOS'", who)
    ).toBeNull()
  })
})

describe('a device named, not identified', () => {
  const named = {
    ...who,
    names: new Map([
      ['iphone 17', THEIRS],
      ['iphone 17 (2)', MINE],
      ['iphone 18 pro', 'AAAAAAAA-0000-0000-0000-000000000009']
    ])
  }
  it("stops simctl aimed at another conversation's simulator by its name", () => {
    expect(simShellVerdict('xcrun simctl install "iPhone 17" build/App.app', named)).toMatch(
      /"iPhone 17" is the simulator of "Fix the login page"/i
    )
    expect(simShellVerdict("xcrun simctl launch 'iPhone 17' com.x.app", named)).toMatch(
      /Fix the login page/
    )
  })
  it('lets its own simulator by name through, and tells "iPhone 17 (2)" from "iPhone 17"', () => {
    expect(simShellVerdict('xcrun simctl install "iPhone 17 (2)" build/App.app', named)).toBeNull()
  })
  it('asks for the UDID when the named simulator is free, since a name is ambiguous', () => {
    expect(simShellVerdict('xcrun simctl boot "iPhone 18 Pro"', named)).toMatch(/by name.*UDID/i)
  })
  it('does not mind a name in a command that only looks', () => {
    expect(simShellVerdict('xcrun simctl list devices "iPhone 17"', named)).toBeNull()
  })
})
