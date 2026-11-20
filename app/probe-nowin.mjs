import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const t0 = Date.now(); const lap = (m) => console.log(((Date.now()-t0)/1000).toFixed(1)+'s', m)
const data = mkdtempSync(join(tmpdir(), 'probe-data-')), proj = mkdtempSync(join(tmpdir(), 'probe-proj-')), home = mkdtempSync(join(tmpdir(), 'probe-home-'))
writeFileSync(join(proj, 'README.md'), '#\n'); mkdirSync(join(home, '.claude'), { recursive: true })
const app = await electron.launch({ args: [join(process.cwd(), 'out', 'main', 'index.js')], env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, HOME: home, NODE_ENV: 'production' } })
lap('launched')
const w = await app.firstWindow(); lap('first window ' + (await w.title()))
await w.waitForLoadState('domcontentloaded'); lap('dom')
await app.close(); lap('closed')
