import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Forgetting an incognito chat takes the agent's own copy with it.
 *
 * Superagent keeps nothing of an incognito chat once it ends, but the agents
 * keep their own logs of a session: Claude Code writes
 * `<config dir>/projects/<project>/<session>.jsonl`, Codex
 * `~/.codex/sessions/…/rollout-…-<session>.jsonl`. Those are removed too,
 * by the session id Superagent recorded, and only inside those folders.
 * (Antigravity keeps its sessions elsewhere and is not covered; the chat says
 * what a provider still receives, which no local deletion can undo.)
 */

/** A real session id and nothing that could name a path. */
const SESSION_ID = /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,79}$/

export interface SessionHomes {
  /** Claude Code config folders: ~/.claude and one per extra account. */
  claude: string[]
  /** Codex's folder (~/.codex). */
  codex: string[]
}

/** Where the agents keep their sessions on this Mac. */
export function sessionHomes(userData: string, home = homedir()): SessionHomes {
  const claude = [join(home, '.claude')]
  const accounts = join(userData, 'claude-accounts')
  try {
    for (const name of readdirSync(accounts)) claude.push(join(accounts, name))
  } catch {
    // no extra accounts
  }
  return { claude, codex: [join(home, '.codex')] }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/** Codex files under sessions/, to a few levels (year/month/day), whose name has the id. */
function codexFiles(dir: string, id: string, depth = 0): string[] {
  if (depth > 4) return []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const n of names) {
    const p = join(dir, n)
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...codexFiles(p, id, depth + 1))
    else if (n.includes(id)) out.push(p)
  }
  return out
}

/** What the agent wrote for this session, if it is on disk. */
export function findSessionFiles(provider: string, id: string, homes: SessionHomes): string[] {
  if (!SESSION_ID.test(id)) return []
  const out: string[] = []
  if (provider === 'claude') {
    for (const dir of homes.claude) {
      const projects = join(dir, 'projects')
      for (const proj of subdirs(projects)) {
        for (const p of [join(projects, proj, `${id}.jsonl`), join(projects, proj, id)])
          if (existsSync(p)) out.push(p)
      }
    }
  } else if (provider === 'codex') {
    for (const dir of homes.codex) out.push(...codexFiles(join(dir, 'sessions'), id))
  }
  return out
}

/** Remove them; returns how many went. */
export function forgetAgentSession(provider: string, id: string, homes: SessionHomes): number {
  let n = 0
  for (const p of findSessionFiles(provider, id, homes)) {
    try {
      rmSync(p, { recursive: true, force: true })
      n++
    } catch {
      // gone, or not ours to remove
    }
  }
  return n
}
