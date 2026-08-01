// onnxruntime-web fetches its WASM from a CDN by default. A desktop app should
// not depend on a CDN at runtime (and our CSP blocks it), so the runtime files
// are copied next to the renderer and loaded from disk instead. Not committed —
// they're ~60MB of build output, regenerated from node_modules on dev/build.
import { copyFileSync, mkdirSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const from = join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist')
const to = join(__dirname, '..', 'src', 'renderer', 'public', 'ort')

mkdirSync(to, { recursive: true })
let n = 0
for (const f of readdirSync(from)) {
  if (!f.startsWith('ort-wasm')) continue
  if (!f.endsWith('.wasm') && !f.endsWith('.mjs')) continue
  copyFileSync(join(from, f), join(to, f))
  n++
}
console.log(`copied ${n} onnxruntime files → src/renderer/public/ort`)
