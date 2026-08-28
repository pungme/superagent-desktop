/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no annotations to give */
// baguette drives the iOS Simulator's input (tap, swipe, key) for the simulator
// pane. It used to be something the user had to `brew install`; now the app
// ships its own copy so tapping works out of the box. Upstream publishes a
// prebuilt arm64 binary per release, so this pins one version + checksum and
// drops the bare executable into native/ for electron-builder to pick up next
// to simfb. Only the executable: the 38 MB resource bundle beside it is for
// baguette's web UI and virtual camera, and input injection runs without it
// (verified — `baguette input` acks gestures from a bare binary).
//
// Not committed. Re-run to upgrade: bump VERSION and SHA256 below.
//
//   node scripts/fetch-baguette.mjs             fail the build if it can't be fetched
//   node scripts/fetch-baguette.mjs --optional  warn only (dev; brew's copy is the fallback)
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const VERSION = '0.1.96'
const SHA256 = 'c4e3a1ebe75cc1017abab6daff252f0877316d73201aaa95c84181063d280f73'
const TARBALL = `https://github.com/tddworks/baguette/releases/download/v${VERSION}/baguette_v${VERSION}_macOS_arm64.tar.gz`
const LICENSE = `https://raw.githubusercontent.com/tddworks/baguette/v${VERSION}/LICENSE`

const optional = process.argv.includes('--optional')
const __dirname = dirname(fileURLToPath(import.meta.url))
const native = join(__dirname, '..', 'native')
const dest = join(native, 'baguette')
const licenseDest = join(native, 'baguette.LICENSE')

function fail(msg) {
  if (optional || existsSync(dest)) {
    console.warn(
      `baguette: ${msg} — ${existsSync(dest) ? 'keeping the existing copy' : 'skipping; brew’s copy is the fallback'}`
    )
    process.exit(0)
  }
  console.error(`baguette: ${msg}`)
  process.exit(1)
}

function installedVersion() {
  if (!existsSync(dest)) return null
  try {
    return execFileSync(dest, ['--version'], { timeout: 4000 }).toString().trim()
  } catch {
    return null
  }
}

if (process.platform !== 'darwin') {
  console.log('baguette: not macOS, skipping')
  process.exit(0)
}
if (process.arch !== 'arm64') {
  console.warn(
    'baguette: upstream only ships arm64 builds; this binary will not run on this machine'
  )
}
if (installedVersion() === VERSION && existsSync(licenseDest)) {
  console.log(`baguette: ${VERSION} already in native/`)
  process.exit(0)
}

let tar, license
try {
  const [t, l] = await Promise.all([fetch(TARBALL), fetch(LICENSE)])
  if (!t.ok) throw new Error(`${t.status} for ${TARBALL}`)
  if (!l.ok) throw new Error(`${l.status} for ${LICENSE}`)
  tar = Buffer.from(await t.arrayBuffer())
  license = await l.text()
} catch (e) {
  fail(`download failed (${e?.message ?? e})`)
}

const sum = createHash('sha256').update(tar).digest('hex')
if (sum !== SHA256) fail(`checksum mismatch for v${VERSION}: got ${sum}, expected ${SHA256}`)

const work = mkdtempSync(join(tmpdir(), 'baguette-'))
try {
  const tgz = join(work, 'baguette.tgz')
  writeFileSync(tgz, tar)
  // Just the executable, by its exact member name — nothing from the bundle.
  const member = `baguette-v${VERSION}-macOS-arm64/Baguette`
  execFileSync('tar', ['-xzf', tgz, '-C', work, '--strip-components=1', member])
  const bin = join(work, 'Baguette')
  if (!existsSync(bin)) fail(`tarball did not contain ${member}`)
  mkdirSync(native, { recursive: true })
  chmodSync(bin, 0o755)
  renameSync(bin, dest)
  writeFileSync(licenseDest, license)
} finally {
  rmSync(work, { recursive: true, force: true })
}

const got = installedVersion()
if (got !== VERSION) fail(`fetched binary reports ${got ?? 'nothing'}, expected ${VERSION}`)
console.log(`baguette: ${VERSION} → native/baguette`)
