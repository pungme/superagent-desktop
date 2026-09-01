import { ipcMain } from 'electron'
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { toProvider, type AgentProvider } from '../shared/agent-provider'

/**
 * Discovers the agent's skills and slash commands so Superagent can show them as
 * one-click buttons. Running a skill just types `/name` into the session —
 * nothing is reimplemented.
 *
 * Each agent keeps them somewhere different — Claude Code in ~/.claude/{skills,
 * commands} and the project's .claude, Codex in ~/.codex/prompts and the
 * project's .codex — so discovery is per provider and the "/" menu shows what
 * the agent actually running this chat can run. (A live Codex session also
 * reports its own list over the protocol; this is what fills the menu before
 * one has started.)
 */

export interface Skill {
  name: string
  description: string
  scope: 'global' | 'project'
  kind: 'skill' | 'command'
}

/** Pull the first sentence of a SKILL.md/command body, skipping frontmatter, for a description. */
export function parseDescription(content: string): string {
  let body = content
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (fm) {
    const desc = fm[1].match(/^description:\s*(.+)$/m)
    if (desc)
      return desc[1]
        .trim()
        .replace(/^["']|["']$/g, '')
        .slice(0, 140)
    body = content.slice(fm[0].length)
  }
  const lines = body.split('\n').map((l) => l.trim())
  // Prefer the first real prose line; a lone "# Title" heading is a weak description.
  const prose = lines.find((l) => l.length > 0 && !l.startsWith('#'))
  if (prose) return prose.slice(0, 140)
  const heading = lines.find((l) => l.length > 0)
  return (heading ?? '').replace(/^#+\s*/, '').slice(0, 140)
}

function readSkillsDir(dir: string, scope: Skill['scope']): Skill[] {
  if (!existsSync(dir)) return []
  const out: Skill[] = []
  for (const entry of readdirSync(dir)) {
    const skillFile = join(dir, entry, 'SKILL.md')
    if (existsSync(skillFile)) {
      try {
        out.push({
          name: entry,
          description: parseDescription(readFileSync(skillFile, 'utf8')),
          scope,
          kind: 'skill'
        })
      } catch {
        // skip unreadable
      }
    }
  }
  return out
}

function readCommandsDir(dir: string, scope: Skill['scope']): Skill[] {
  if (!existsSync(dir)) return []
  const out: Skill[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    const path = join(dir, entry)
    try {
      // Inside the try: a broken symlink named *.md would otherwise throw here
      // and abort discovery of every skill/command, not just this one entry.
      if (!statSync(path).isFile()) continue
      out.push({
        name: entry.replace(/\.md$/, ''),
        description: parseDescription(readFileSync(path, 'utf8')),
        scope,
        kind: 'command'
      })
    } catch {
      // skip
    }
  }
  return out
}

export function discoverSkills(projectPath?: string, provider: AgentProvider = 'claude'): Skill[] {
  const home = homedir()
  const skills: Skill[] =
    provider === 'codex'
      ? [
          // Codex's custom prompts are flat .md files, the same shape as Claude's
          // commands — one file, one slash command.
          ...readCommandsDir(join(home, '.codex', 'prompts'), 'global'),
          ...readSkillsDir(join(home, '.codex', 'skills'), 'global')
        ]
      : [
          ...readSkillsDir(join(home, '.claude', 'skills'), 'global'),
          ...readCommandsDir(join(home, '.claude', 'commands'), 'global')
        ]
  if (projectPath) {
    const dir = provider === 'codex' ? '.codex' : '.claude'
    skills.push(
      ...readSkillsDir(join(projectPath, dir, 'skills'), 'project'),
      ...readCommandsDir(
        join(projectPath, dir, provider === 'codex' ? 'prompts' : 'commands'),
        'project'
      )
    )
  }
  // De-dupe by name (project overrides global), sort alphabetically.
  const byName = new Map<string, Skill>()
  for (const s of skills) byName.set(s.name, s)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const STARTER_SKILLS: Record<string, string> = {
  'check-my-site': `---
name: check-my-site
description: Open the preview and click through the main flows, reporting anything broken
---

Open the site preview using the cove-browser tools. Click through the main user flows
(navigation, forms, key buttons). Report anything broken, with a screenshot of each problem.
Check the browser console and network for errors too.`,
  'fix-whats-broken': `---
name: fix-whats-broken
description: Find and fix the most obvious bug on the current page
---

Look at the current page in the preview using cove-browser tools. Find the most obvious
thing that's broken or wrong, explain it simply, then fix it in the code and confirm the fix
in the preview.`,
  'mobile-friendly': `---
name: mobile-friendly
description: Check how the page looks on a phone and improve it
---

Use cove-browser tools to look at the current page. Evaluate how it would look on a narrow
phone screen. Improve the responsive layout so it looks good on mobile, then verify.`
}

/**
 * Install Superagent's starter skills into the agent's own global directory.
 *
 * The bodies are agent-agnostic — they describe using the cove-browser tools,
 * which both agents get — so only the destination and the file layout differ:
 * Claude Code wants a folder per skill with a SKILL.md, Codex wants one flat
 * prompt file per command.
 */
export function installStarterSkills(provider: AgentProvider = 'claude'): void {
  const home = homedir()
  for (const [name, content] of Object.entries(STARTER_SKILLS)) {
    const file =
      provider === 'codex'
        ? join(home, '.codex', 'prompts', `${name}.md`)
        : join(home, '.claude', 'skills', name, 'SKILL.md')
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
  }
}

export function registerSkillsIpc(): void {
  ipcMain.handle('skills:list', (_e, projectPath?: string, provider?: AgentProvider) =>
    discoverSkills(projectPath, toProvider(provider))
  )
  ipcMain.handle('skills:installStarters', (_e, provider?: AgentProvider) => {
    const p = toProvider(provider)
    installStarterSkills(p)
    return discoverSkills(undefined, p)
  })
}
