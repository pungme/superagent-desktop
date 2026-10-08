import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, it } from 'vitest'

/**
 * A turned simulator is drawn with an inline `transform: rotate(…)`. A CSS
 * animation that is still applying a transform — while it plays, or after it
 * ends through `forwards` / `both` — outranks an inline style, and the device
 * is then sized for the turn but drawn unturned, lying on its side. This
 * shipped once; a real simulator is needed to see it, so the stylesheet is
 * checked instead.
 */
it("the simulator picture's entrance animation leaves its rotation alone", () => {
  const css = readFileSync(join(__dirname, 'assets', 'main.css'), 'utf8')
  const rule = /\n\.sim-screen \{[^}]*\}/.exec(css)?.[0] ?? ''
  const name = /animation:\s*([\w-]+)/.exec(rule)?.[1]
  expect(name, '.sim-screen has an entrance animation').toBeTruthy()
  expect(rule).not.toMatch(/animation:[^;]*\b(both|forwards)\b/)
  const frames = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? ''
  expect(frames).not.toBe('')
  expect(frames).not.toMatch(/\btransform\s*:/)
})
