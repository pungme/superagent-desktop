/**
 * The floor under "keep working with the lid closed": a closed Mac in a bag,
 * held awake, runs its battery flat. Below a level the user picks it is let go
 * to sleep, and told so; back on power, or charged past the level again, it
 * is held awake once more.
 */

export const DEFAULT_BATTERY_FLOOR = 20
/** "Never": no floor. */
export const NO_BATTERY_FLOOR = 0
export const BATTERY_FLOORS = [NO_BATTERY_FLOOR, 10, 20, 30, 50]

export interface BatteryState {
  /** Plugged in (charging or charged). */
  onPower: boolean
  /** 0 to 100; null when there is no battery (a desktop) or it could not be read. */
  percent: number | null
}

/** What `pmset -g batt` said, or nulls when it did not say. */
export function parseBattery(text: string): BatteryState {
  const onPower = /drawing from 'AC Power'/i.test(text)
  const m = /(\d{1,3})%/.exec(text)
  const percent = m ? Math.max(0, Math.min(100, Number(m[1]))) : null
  return { onPower, percent: /InternalBattery/i.test(text) ? percent : null }
}

/**
 * Whether the Mac should be held awake now. `floor` 0 is no floor. Once let
 * go, it is not held again until charged a little past the floor, so it does
 * not flap at the line.
 */
export function holdAwake(b: BatteryState, floor: number, wasLetGo: boolean): boolean {
  if (!floor || b.onPower || b.percent === null) return true
  return wasLetGo ? b.percent >= floor + 5 : b.percent >= floor
}
