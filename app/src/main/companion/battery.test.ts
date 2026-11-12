import { describe, it, expect } from 'vitest'
import { toWireBattery } from './battery'
import { parseBattery } from '../../shared/battery-floor'

describe('toWireBattery', () => {
  it('reads the percent and the charger from pmset', () => {
    const on =
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t83%; charging; 1:02 remaining"
    const off =
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t41%; discharging; 3:10 remaining"
    expect(toWireBattery(parseBattery(on))).toEqual({ percent: 83, pluggedIn: true })
    expect(toWireBattery(parseBattery(off))).toEqual({ percent: 41, pluggedIn: false })
  })
  it('says nothing for a Mac with no battery', () => {
    expect(toWireBattery(parseBattery("Now drawing from 'AC Power'\n"))).toBeNull()
  })
})
