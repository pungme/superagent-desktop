#!/usr/bin/env node
/**
 * The tour shows the website's animated drawings (docs/index.html), not copies
 * that drift. This takes the drawing engine and its styles out of the page and
 * writes them beside the tour:
 *
 *   src/renderer/src/tour/gfx.generated.js   mountGfx(element, scene) → { play, pause, seek, still }
 *   src/renderer/src/tour/gfx.generated.css  the drawings' styles
 *
 * Run it after changing a drawing on the website: node scripts/sync-tour-gfx.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const page = readFileSync(join(app, '..', 'docs', 'index.html'), 'utf8')
const out = join(app, 'src', 'renderer', 'src', 'tour')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a plain .mjs script
const between = (from, to) => {
  const a = page.indexOf(from)
  if (a < 0) throw new Error(`not in docs/index.html: ${from}`)
  const b = page.indexOf(to, a)
  if (b < 0) throw new Error(`not in docs/index.html: ${to}`)
  return page.slice(a, b)
}

const HEAD = '/* Generated from docs/index.html by scripts/sync-tour-gfx.mjs. Do not edit. */\n'

// The styles: from the drawings' design system to the small tiles, which the tour does not use.
let css = between('/* Animated drawings of the app: one design system.', '/* Small things:')
css = css
  .replaceAll(
    'var(--font)',
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'
  )
  .replaceAll('var(--ink)', '#1d1d1f')
writeFileSync(join(out, 'gfx.generated.css'), HEAD + css.trim() + '\n')

// The agents' logos, as symbols the drawings refer to by id.
const symbols = between('<svg width="0" height="0" style="position:absolute"', '</svg>') + '</svg>'

// The engine and every scene: the page's script, minus the part that finds the page's pictures.
const start = '// Animated drawings of the app. Each one'
let body = between(start, 'const all = {};')
body = body.slice(body.indexOf('(() => {') + '(() => {'.length)
writeFileSync(
  join(out, 'gfx.generated.js'),
  HEAD +
    '/* eslint-disable */\n// @ts-nocheck\n' +
    `const SYMBOLS = ${JSON.stringify(symbols)}\n` +
    'export function mountGfx(gfx, name) {\n' +
    body +
    "\n  // The agents' logos the drawings <use>, defined once in the document as on the page.\n" +
    '  if (!document.getElementById("mk-claude")) document.body.insertAdjacentHTML("beforeend", SYMBOLS)\n' +
    '  const spec = scenes[name]\n  if (!spec) throw new Error(`no drawing called ${name}`)\n  return engine(gfx, spec)\n}\n'
)
console.log('wrote gfx.generated.js and gfx.generated.css')
