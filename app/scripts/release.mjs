#!/usr/bin/env node
/**
 * Cut a Mac release. The only supported way to do it.
 *
 * This exists because the release has two steps that FAIL BY SUCCEEDING, and a
 * README note did not stop either of them happening:
 *
 *   1. Missing notarization credentials do not fail the build. electron-builder
 *      logs "skipped macOS notarization" and exits 0, handing you a signed-but-
 *      un-notarized DMG. It passes spctl on the machine that built it and is
 *      blocked by Gatekeeper on every other Mac. You find out from users.
 *
 *   2. A release uploaded without GitHub's "latest" flag is invisible to the
 *      updater. electron-updater asks for the latest release; if GitHub still
 *      points at an older tag, every user is told they are up to date. v1.7.23
 *      and v1.7.24 both shipped this way and nobody received either.
 *
 * So: every check is a hard failure, the credentials are loaded here rather
 * than relied on from the shell, and nothing is uploaded until the artifacts on
 * disk have been verified to be what they claim.
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(APP, 'dist')

const die = (msg, fix) => {
  console.error(`\n  RELEASE STOPPED\n\n  ${msg}\n${fix ? `\n  Fix: ${fix}\n` : ''}`)
  process.exit(1)
}
const step = (msg) => console.log(`\n▸ ${msg}`)
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: APP, encoding: 'utf8', stdio: 'pipe', ...opts })
const runLoud = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: APP, stdio: 'inherit', ...opts })

// ---------------------------------------------------------------- preflight

/**
 * Load .env ourselves. The documented incantation was
 * `set -a && source .env && set +a && npm run build:mac`, and forgetting the
 * source half is exactly what produces an un-notarized build — so it is no
 * longer something anyone has to remember.
 */
function loadEnv() {
  const file = join(APP, '.env')
  if (!existsSync(file)) die('app/.env is missing.', 'copy app/.env.example to app/.env and fill it in')
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '')
  }
}

function checkCredentials() {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID) die('APPLE_ID is empty in app/.env.', 'your Apple ID email')
  if (!APPLE_APP_SPECIFIC_PASSWORD)
    die(
      'APPLE_APP_SPECIFIC_PASSWORD is empty in app/.env.',
      'generate one at appleid.apple.com → Sign-In and Security → App-Specific Passwords'
    )
  if (!APPLE_TEAM_ID) die('APPLE_TEAM_ID is empty in app/.env.')
  // An app-specific password is xxxx-xxxx-xxxx-xxxx. A regular Apple ID
  // password here fails at the notarization step, minutes into the build.
  if (!/^[a-z]{4}(-[a-z]{4}){3}$/i.test(APPLE_APP_SPECIFIC_PASSWORD))
    die(
      'APPLE_APP_SPECIFIC_PASSWORD is not in xxxx-xxxx-xxxx-xxxx form — that looks like a regular Apple ID password.',
      'app-specific passwords come from appleid.apple.com'
    )
}

function checkGh() {
  try {
    run('gh', ['auth', 'status'])
  } catch {
    die('gh is not installed or not logged in.', 'brew install gh && gh auth login')
  }
}

function checkGitClean() {
  const dirty = run('git', ['status', '--porcelain']).trim()
  if (dirty) die(`the working tree has uncommitted changes:\n\n${dirty}`, 'commit or stash first')
}

function readVersion() {
  const v = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).version
  if (!existsSync(join(APP, `notes-${v}.md`)))
    die(`app/notes-${v}.md is missing — every release has notes.`, `write app/notes-${v}.md`)
  const tags = run('git', ['tag', '--list', `v${v}`]).trim()
  if (tags) die(`tag v${v} already exists — the version was not bumped.`)
  return v
}

// ------------------------------------------------------------ verification

const sha512 = (file) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha512')
    createReadStream(file)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('base64')))
  })

/**
 * The check that would have caught the un-notarized build. A stapled ticket and
 * "Notarized Developer ID" — plain "Developer ID" means signed only, which is
 * what a silently skipped notarization leaves behind.
 */
function assertNotarized(target) {
  try {
    run('xcrun', ['stapler', 'validate', target])
  } catch {
    die(
      `${target} has no stapled notarization ticket.\n  electron-builder logged success but did not notarize.`,
      'check the credentials in app/.env'
    )
  }
  let out = ''
  try {
    out = run('spctl', ['-a', '-vvv', '-t', 'exec', target], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  if (!/source=Notarized Developer ID/.test(out))
    die(`${target} is signed but NOT notarized:\n\n${out.trim()}`)
}

/**
 * Stapling rewrites the DMG, so any hash taken before it is wrong — and a wrong
 * sha512 in latest-mac.yml fails the updater's integrity check AFTER the user
 * has downloaded 226 MB. Recompute both entries from what is actually on disk.
 */
async function rewriteLatestYml(version) {
  const yml = join(DIST, 'latest-mac.yml')
  if (!existsSync(yml)) die('dist/latest-mac.yml is missing — the build did not produce an update feed.')
  let text = readFileSync(yml, 'utf8')
  for (const name of [`SuperAgent-${version}-arm64-mac.zip`, 'SuperAgent.dmg']) {
    const file = join(DIST, name)
    if (!existsSync(file)) die(`dist/${name} is missing.`)
    const hash = await sha512(file)
    const size = statSync(file).size
    const block = new RegExp(`(- url: ${name.replace(/\./g, '\\.')}\\n\\s+sha512: )[^\\n]+(\\n\\s+size: )\\d+`)
    if (!block.test(text)) die(`could not find ${name} in latest-mac.yml to update its hash.`)
    text = text.replace(block, `$1${hash}$2${size}`)
    // The top-level sha512/path point at the zip, which is what MacUpdater installs.
    if (name.endsWith('.zip')) {
      text = text.replace(/^sha512: .+$/m, `sha512: ${hash}`)
    }
  }
  writeFileSync(yml, text)
  return yml
}

// ------------------------------------------------------------------- main

loadEnv()
step('Checking credentials, gh and the working tree')
checkCredentials()
checkGh()
checkGitClean()
const version = readVersion()
console.log(`  releasing ${version}`)

step('Building (notarization is a round-trip to Apple — several minutes)')
runLoud('npm', ['run', 'build:native'])
runLoud('npx', ['electron-vite', 'build'])
runLoud('npx', ['electron-builder', '--mac', '--publish', 'never'])

step('Verifying the app was really notarized')
assertNotarized(join(DIST, 'mac-arm64', 'SuperAgent.app'))
console.log('  app: Notarized Developer ID ✓')

step('Notarizing and stapling the DMG (notarize: true covers the app, not the DMG)')
const dmg = join(DIST, 'SuperAgent.dmg')
runLoud('xcrun', [
  'notarytool', 'submit', dmg,
  '--apple-id', process.env.APPLE_ID,
  '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
  '--team-id', process.env.APPLE_TEAM_ID,
  '--wait'
])
runLoud('xcrun', ['stapler', 'staple', dmg])
assertNotarized(dmg)
console.log('  dmg: stapled ✓')

step('Rewriting latest-mac.yml against the stapled files')
const yml = await rewriteLatestYml(version)

step('Publishing')
const assets = [
  yml,
  join(DIST, `SuperAgent-${version}-arm64-mac.zip`),
  join(DIST, `SuperAgent-${version}-arm64-mac.zip.blockmap`),
  dmg
]
runLoud('gh', [
  'release', 'create', `v${version}`,
  ...assets,
  '--title', `Superagent ${version}`,
  '--notes-file', join(APP, `notes-${version}.md`),
  // Without this the updater never sees the release: it asks GitHub for the
  // latest one and is told an older tag. This is why 1.7.23 and 1.7.24 never
  // reached anybody.
  '--latest'
])

step('Confirming GitHub really marked it latest')
const isLatest = run('gh', ['release', 'view', `v${version}`, '--json', 'isLatest', '-q', '.isLatest']).trim()
if (isLatest !== 'true')
  die(`v${version} was uploaded but GitHub did not mark it latest — users will not be offered it.`,
      `gh release edit v${version} --latest`)

console.log(`\n  Released ${version}, notarized and flagged latest.\n`)
