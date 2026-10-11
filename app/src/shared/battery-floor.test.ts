import { describe, expect, it } from 'vitest'
import { hasLid, holdAwake, parseBattery } from './battery-floor'

describe('the battery floor under working with the lid closed', () => {
  it('reads what pmset says', () => {
    expect(
      parseBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=36110435)\t100%; charged; 0:00 remaining present: true\n"
      )
    ).toEqual({ onPower: true, percent: 100 })
    expect(
      parseBattery(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t17%; discharging; 1:02 remaining present: true\n"
      )
    ).toEqual({ onPower: false, percent: 17 })
    // A desktop has no battery to run down.
    expect(parseBattery("Now drawing from 'AC Power'\n")).toEqual({ onPower: true, percent: null })
    expect(parseBattery('')).toEqual({ onPower: false, percent: null })
  })

  it('lets go below the floor on battery, and only on battery', () => {
    expect(holdAwake({ onPower: false, percent: 19 }, 20, false)).toBe(false)
    expect(holdAwake({ onPower: false, percent: 20 }, 20, false)).toBe(true)
    expect(holdAwake({ onPower: true, percent: 5 }, 20, false)).toBe(true)
    expect(holdAwake({ onPower: false, percent: 5 }, 0, false)).toBe(true)
    expect(holdAwake({ onPower: false, percent: null }, 20, false)).toBe(true)
  })

  it('holds again only once charged a little past the floor', () => {
    expect(holdAwake({ onPower: false, percent: 21 }, 20, true)).toBe(false)
    expect(holdAwake({ onPower: false, percent: 25 }, 20, true)).toBe(true)
    expect(holdAwake({ onPower: true, percent: 21 }, 20, true)).toBe(true)
  })
})

describe('whether there is a lid to close', () => {
  it('a Mac with a battery of its own has one', () => {
    expect(
      hasLid(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true"
      )
    ).toBe(true)
  })
  it('a desktop, on mains or on a UPS, has none', () => {
    expect(hasLid("Now drawing from 'AC Power'\n")).toBe(false)
    expect(hasLid("Now drawing from 'UPS Power'\n -UPS-1500 (id=2)\t80%; discharging")).toBe(false)
  })
  it('an unanswered question is not taken as no', () => {
    expect(hasLid('')).toBe(true)
  })
})
