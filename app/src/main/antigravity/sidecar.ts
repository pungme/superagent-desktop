import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { COVE_MCP_SERVER, type AgyMode } from './approvals'

/**
 * The folder that makes one `agy` process a Superagent session.
 *
 * Antigravity takes no `--mcp-config` and no hook flags. It reads both from an
 * `.agents/` folder inside each directory it was given — the user's global
 * `~/.gemini/config`, the project, and anything passed as `--add-dir`. So each
 * chat gets a private folder of its own holding exactly two files, and is the
 * only process launched with that folder as an extra `--add-dir`:
 *
 *  - `.agents/mcp_config.json` names Superagent's tool server, scoped to this
 *    chat, the way Claude Code's `--mcp-config` file and Codex's per-thread
 *    config do.
 *  - `.agents/hooks.json` installs one `PreToolUse` hook that asks Superagent
 *    before a tool runs (see approvals.ts). It is the session's whole
 *    permission gate, so the command fails closed.
 *
 * Nothing is written into the user's project or into their Antigravity
 * settings, so there is no file of theirs to leave changed, nothing for a
 * repository to ignore, and no shared file for two chats to overwrite. Both
 * files carry this launch's localhost secrets, so the folder is readable by the
 * user alone and is rewritten on every spawn.
 */

export interface SidecarOptions {
  /** Where the folder goes. One per chat (or per routine pane). */
  dir: string
  /** Superagent's MCP server, already scoped to the workspace and chat. */
  mcpUrl?: string
  /** Superagent's hook server. Without it no hook is installed. */
  hookUrl?: string
  workspaceId?: string
  /** The conversation in the app this session belongs to, if it has one. */
  chatId?: string
  mode?: AgyMode
}

/** How long a held approval may take. Just past the app's own permission timeout. */
const HOOK_TIMEOUT_SECONDS = 600

/** Single-quote a value for `sh`, so nothing in it is ever read as syntax. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The hook's command: hand Antigravity's JSON to Superagent and print the
 * answer. `curl` rather than a script file — the payload goes in on stdin and
 * the verdict comes back on stdout, which is the whole contract.
 */
export function hookCommand(
  hookUrl: string,
  workspaceId: string,
  mode: AgyMode,
  chatId?: string
): string {
  // The chat rides along because the window shows an approval inside the chat
  // it belongs to, and Antigravity's own payload only knows its conversation id.
  const query =
    `mode=${encodeURIComponent(mode)}` + (chatId ? `&chat=${encodeURIComponent(chatId)}` : '')
  // If Superagent cannot be reached the hook answers for itself. In the modes
  // where it is the gate, that answer is no: the CLI was told to approve
  // everything, so silence must never read as permission.
  const unreachable =
    mode === 'bypassPermissions'
      ? '{"decision":"allow"}'
      : '{"decision":"deny","reason":"Superagent could not be reached to approve this, so it was not run."}'
  return (
    [
      'curl -sS --fail',
      `--max-time ${HOOK_TIMEOUT_SECONDS - 10}`,
      '-X POST',
      `-H ${shellQuote('content-type: application/json')}`,
      `-H ${shellQuote(`x-cove-workspace: ${workspaceId}`)}`,
      '--data-binary @-',
      shellQuote(`${hookUrl}/AgyPreToolUse?${query}`)
    ].join(' ') + ` 2>/dev/null || echo ${shellQuote(unreachable)}`
  )
}

export function sidecarFiles(opts: SidecarOptions): { mcp: string; hooks: string } {
  const mcp = {
    mcpServers: opts.mcpUrl
      ? // `serverUrl`, not `url`: Antigravity ignores the field name the others use.
        { [COVE_MCP_SERVER]: { serverUrl: opts.mcpUrl, disabled: false } }
      : {}
  }
  const hooks = opts.hookUrl
    ? {
        'superagent-approvals': {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: hookCommand(
                    opts.hookUrl,
                    opts.workspaceId ?? '',
                    opts.mode ?? 'bypassPermissions',
                    opts.chatId
                  ),
                  timeout: HOOK_TIMEOUT_SECONDS
                }
              ]
            }
          ]
        }
      }
    : {}
  return { mcp: JSON.stringify(mcp, null, 2) + '\n', hooks: JSON.stringify(hooks, null, 2) + '\n' }
}

/** A file appears whole or not at all: agy reads these while it starts. */
function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
}

/** Write (or rewrite) a session's folder and return it, for `--add-dir`. */
export function writeSidecar(opts: SidecarOptions): string {
  const agents = join(opts.dir, '.agents')
  mkdirSync(agents, { recursive: true, mode: 0o700 })
  const files = sidecarFiles(opts)
  writeAtomic(join(agents, 'mcp_config.json'), files.mcp)
  writeAtomic(join(agents, 'hooks.json'), files.hooks)
  return opts.dir
}

export function removeSidecar(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Nothing to remove is not a failure.
  }
}

/** Folders in use by this app run. Anything else under the root is a leftover. */
const live = new Set<string>()
let swept = false

/** Mark a folder as in use, so the sweep leaves it alone. */
export function claimSidecar(dir: string): void {
  live.add(dir)
}

/** The session is over: forget the folder and delete it, secrets and all. */
export function releaseSidecar(dir: string): void {
  live.delete(dir)
  removeSidecar(dir)
}

/**
 * Once per launch: delete the folders a crashed or force-quit run left behind,
 * which is the only way one outlives its session.
 */
export function sweepSidecars(root: string): void {
  if (swept) return
  swept = true
  try {
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      if (!live.has(dir)) removeSidecar(dir)
    }
  } catch {
    // No folder yet: nothing was left behind.
  }
}

/** A chat or pane id as a single safe path segment. */
export function sidecarName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'session'
}
