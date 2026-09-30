// Shared beat grid. 128 BPM, 4/4, 16 bars = exactly 30 s.
export const BPM = 128
export const BEAT = 60 / BPM // 0.46875
export const BAR = BEAT * 4 // 1.875
export const DURATION = 30
export const FPS = 60
// T(bar, beat): bar and beat are 1-indexed, beat may be fractional (1.5 = the "and" of 1).
export const T = (bar, beat = 1) => (bar - 1) * BAR + (beat - 1) * BEAT
// Kick grid, used by both the drum track and the camera bump.
export function kickTimes() {
  const k = []
  for (let bar = 3; bar <= 15; bar++) {
    if (bar === 14) { k.push(T(14, 1), T(14, 2), T(14, 3)); continue }
    if (bar === 9 || bar === 10) { k.push(T(bar, 1), T(bar, 2.5), T(bar, 3.5)); continue }
    for (let b = 1; b <= 4; b++) k.push(T(bar, b))
  }
  k.push(T(16, 1))
  k.push(0) // opening sub hit
  return k.sort((a, b) => a - b)
}
