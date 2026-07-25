import { ipcMain } from 'electron'
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Discovers Claude Code skills and slash commands so Cove can show them as
 * one-click buttons. Running a skill just types `/name` into the session —
 * nothing is reimplemented.
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
    if (desc) return desc[1].trim().replace(/^["']|["']$/g, '').slice(0, 140)
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
    if (!statSync(path).isFile()) continue
    try {
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

export function discoverSkills(projectPath?: string): Skill[] {
  const home = homedir()
  const skills: Skill[] = [
    ...readSkillsDir(join(home, '.claude', 'skills'), 'global'),
    ...readCommandsDir(join(home, '.claude', 'commands'), 'global')
  ]
  if (projectPath) {
    skills.push(
      ...readSkillsDir(join(projectPath, '.claude', 'skills'), 'project'),
      ...readCommandsDir(join(projectPath, '.claude', 'commands'), 'project')
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

/** Install Cove's starter skills into the user's global skills dir if missing. */
export function installStarterSkills(): void {
  const base = join(homedir(), '.claude', 'skills')
  for (const [name, content] of Object.entries(STARTER_SKILLS)) {
    const dir = join(base, name)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, content)
    }
  }
}

export function registerSkillsIpc(): void {
  ipcMain.handle('skills:list', (_e, projectPath?: string) => discoverSkills(projectPath))
  ipcMain.handle('skills:installStarters', () => {
    installStarterSkills()
    return discoverSkills()
  })
}
