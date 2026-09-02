#!/usr/bin/env node
/**
 * Ask the transcripts whether this build's assumptions about its agents are
 * still true.
 *
 * The bug this exists for leaves no trace at the moment it happens. When a tool
 * the app special-cases by name is renamed, nothing throws and no call fails —
 * a feature just stops working, and stays broken until a person happens to
 * notice. 'Task' became 'Agent' and sub-agents vanished from "Running in
 * background" for a release. The evidence was sitting in the database the whole
 * time: 27 calls to 'Agent', not one to 'Task'.
 *
 * So this reads the real transcripts and reports drift in both directions:
 *
 *   unknown   a tool is being called that this build has never heard of —
 *             usually harmless, but a renamed tool looks exactly like this
 *   unused    a tool this build changes behaviour for is never called at all —
 *             which is what a rename leaves behind on the other side
 *
 * A rename shows up as both at once, which is the signature worth acting on.
 *
 * Read-only, deterministic, no network and no model. Run it whenever; it is
 * cheap. `npm run check:assumptions`
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const DB = join(homedir(), 'Library', 'Application Support', 'superagent', 'cove.db')

/** The shared list, read as text — this script has no TypeScript to import it with. */
function knownTools() {
  const src = readFileSync(join(here, '..', 'src', 'shared', 'known-tools.ts'), 'utf8')
  const section = (name) => {
    const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`))
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  }
  return { all: section('KNOWN_TOOLS'), loadBearing: section('LOAD_BEARING_TOOLS') }
}

/** Tool names in stored transcripts, with how often and how recently. */
function toolsSeen() {
  const sql =
    "SELECT json_extract(value,'$.tool.name') AS n, COUNT(*) c, " +
    "date(MAX(chats.updatedAt)/1000,'unixepoch') AS last " +
    'FROM chats, json_each(chats.data) WHERE n IS NOT NULL GROUP BY n;'
  const out = execFileSync('sqlite3', [DB, sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, count, last] = line.split('|')
      return { name, count: Number(count), last }
    })
    // MCP tools are ours and are named by their server, not by the agent's
    // vocabulary — they cannot be renamed out from under us.
    .filter((t) => !t.name.startsWith('mcp__'))
}

if (!existsSync(DB)) {
  console.log('No database yet — nothing to check. Run the app first.')
  process.exit(0)
}

const { all, loadBearing } = knownTools()
const seen = toolsSeen()
const seenNames = new Set(seen.map((t) => t.name))

// Called, but this build has never heard of it.
const unknown = seen.filter((t) => !all.includes(t.name)).sort((a, b) => b.count - a.count)
// Handled specially, but never actually called — the other half of a rename.
const unused = loadBearing.filter((n) => !seenNames.has(n))

let problems = 0

if (unknown.length) {
  console.log('\nTools being called that this build does not know:')
  for (const t of unknown) console.log(`  ${t.name.padEnd(28)} ${t.count} calls, last ${t.last}`)
  console.log('  → harmless unless one of them is a tool we special-case, renamed.')
}

if (unused.length) {
  problems += unused.length
  console.log('\nTools this build changes behaviour for, that nothing ever calls:')
  for (const n of unused) console.log(`  ${n}`)
  console.log('  → a rename leaves exactly this behind. Check where the name is matched.')
}

if (unknown.length && unused.length) {
  console.log(
    '\n⚠ Both at once is the signature of a rename: something new is being called while\n' +
      '  something we depend on has gone silent. Compare the two lists above.'
  )
}

if (!unused.length) {
  console.log(
    unknown.length
      ? '\nEvery tool this build depends on is still being called by that name.'
      : 'Every tool this build depends on is still being called by that name.'
  )
}
console.log(
  '\nNote: Edit/Write/MultiEdit become diff items with no tool name, and BashOutput/KillShell\n' +
    'never reach the transcript. They are special-cased in the app but cannot be checked here.'
)

process.exit(problems > 0 ? 1 : 0)
