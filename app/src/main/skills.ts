import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  rmSync
} from 'fs'
import { join, dirname, basename, extname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { toProvider, type AgentProvider } from '../shared/agent-provider'
import {
  SkillError,
  alreadyThere,
  bundleFromMarkdown,
  bundlesFromFolder,
  bundlesFromLink,
  bundlesFromZip,
  hasScripts,
  installBundles,
  removablePath,
  skillTargets,
  MAX_DOWNLOAD,
  type OnConflict,
  type SkillBundle
} from './skill-install'

/**
 * Discovers the agent's skills and slash commands so Superagent can show them as
 * one-click buttons. Running a skill just types `/name` into the session —
 * nothing is reimplemented.
 *
 * Each agent keeps them somewhere different — Claude Code in ~/.claude/{skills,
 * commands} and the project's .claude, Codex in ~/.codex/prompts and the
 * project's .codex, Antigravity in ~/.gemini/antigravity-cli/skills and the
 * project's .agents — so discovery is per provider and the "/" menu shows what
 * the agent actually running this chat can run. (A live Codex session also
 * reports its own list over the protocol; this is what fills the menu before
 * one has started.)
 */

export interface Skill {
  name: string
  description: string
  /** claude.ai: on the account at claude.ai, synced here by Claude Code; managed there. */
  scope: 'global' | 'project' | 'claude.ai'
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

/**
 * The skills of the claude.ai accounts signed in here. Claude Code keeps them in
 * sync itself, one folder per organisation and user under ~/.claude/skills/synced
 * (read from 2.1.314), and loads them in every session: nothing to import, only
 * to show. They are changed on claude.ai, so they are not removed from here.
 */
function readSyncedSkills(home: string): Skill[] {
  const root = join(home, '.claude', 'skills', 'synced')
  if (!existsSync(root)) return []
  const out: Skill[] = []
  try {
    for (const account of readdirSync(root)) {
      if (account.startsWith('.')) continue
      out.push(...readSkillsDir(join(root, account), 'claude.ai'))
    }
  } catch {
    // unreadable: nothing to show
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
      : provider === 'antigravity'
        ? [
            // Antigravity keeps a folder per skill with a SKILL.md, like Claude
            // Code. The CLI reads its own folder; the shared one is where the
            // desktop app and the IDE keep theirs.
            ...readSkillsDir(join(home, '.gemini', 'config', 'skills'), 'global'),
            ...readSkillsDir(join(home, '.gemini', 'antigravity-cli', 'skills'), 'global')
          ]
        : [
            // First, so a skill of your own by the same name wins.
            ...readSyncedSkills(home),
            ...readSkillsDir(join(home, '.claude', 'skills'), 'global'),
            ...readCommandsDir(join(home, '.claude', 'commands'), 'global')
          ]
  if (projectPath) {
    if (provider === 'antigravity') {
      skills.push(
        ...readSkillsDir(join(projectPath, '.agents', 'skills'), 'project'),
        // Workflows are its flat one-file slash commands.
        ...readCommandsDir(join(projectPath, '.agents', 'workflows'), 'project')
      )
    } else {
      const dir = provider === 'codex' ? '.codex' : '.claude'
      skills.push(
        ...readSkillsDir(join(projectPath, dir, 'skills'), 'project'),
        ...readCommandsDir(
          join(projectPath, dir, provider === 'codex' ? 'prompts' : 'commands'),
          'project'
        )
      )
    }
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
 * which every agent gets — so only the destination and the file layout differ:
 * Claude Code and Antigravity want a folder per skill with a SKILL.md, Codex
 * wants one flat prompt file per command.
 */
export function installStarterSkills(provider: AgentProvider = 'claude'): void {
  const home = homedir()
  for (const [name, content] of Object.entries(STARTER_SKILLS)) {
    const file =
      provider === 'codex'
        ? join(home, '.codex', 'prompts', `${name}.md`)
        : provider === 'antigravity'
          ? join(home, '.gemini', 'antigravity-cli', 'skills', name, 'SKILL.md')
          : join(home, '.claude', 'skills', name, 'SKILL.md')
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
  }
}

/** What the panel is shown before it installs: read and checked, nothing written yet. */
export interface SkillPreview {
  token: string
  skills: {
    name: string
    description: string
    hasScripts: boolean
    /** Files besides SKILL.md that a flat Codex prompt leaves out. */
    extraFiles: number
    exists: { global: boolean; project: boolean }
  }[]
  /** Whether this agent has a project-level folder to offer. */
  canProject: boolean
}

export type SkillSource = { kind: 'folder' } | { kind: 'file' } | { kind: 'link'; url: string }

interface Pending {
  bundles: SkillBundle[]
  provider: AgentProvider
  projectPath?: string
}
const pending = new Map<string, Pending>()

/** The app's own window, its top frame: a page in a browser pane never installs or removes. */
function fromApp(e: IpcMainInvokeEvent): boolean {
  return e.senderFrame === e.sender.mainFrame && !!BrowserWindow.fromWebContents(e.sender)
}

/**
 * Move to the Trash. A test run (which answers the picker itself) deletes in
 * its temporary home instead, so tests never fill the real Trash.
 */
async function trash(path: string): Promise<void> {
  if (process.env.COVE_E2E_PICK_SKILL) rmSync(path, { recursive: true, force: true })
  else await shell.trashItem(path)
}

async function pick(kind: 'folder' | 'file'): Promise<string | null> {
  // A test answers the picker through a file it writes before each click,
  // instead of driving macOS's out-of-process dialog.
  if (process.env.COVE_E2E_PICK_SKILL)
    return readFileSync(process.env.COVE_E2E_PICK_SKILL, 'utf8').trim()
  const win = BrowserWindow.getFocusedWindow()
  const opts: Electron.OpenDialogOptions =
    kind === 'folder'
      ? {
          properties: ['openDirectory'],
          message: 'Choose a skill folder (one with a SKILL.md in it)'
        }
      : {
          properties: ['openFile'],
          filters: [{ name: 'Skill', extensions: ['zip', 'skill', 'md'] }]
        }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
}

async function readSource(source: SkillSource): Promise<SkillBundle[] | null> {
  if (source.kind === 'link') return bundlesFromLink(source.url)
  const path = await pick(source.kind)
  if (!path) return null
  if (statSync(path).isDirectory()) return bundlesFromFolder(path)
  if (statSync(path).size > MAX_DOWNLOAD) throw new SkillError('That file is too big for a skill.')
  const ext = extname(path).toLowerCase()
  const name = basename(path, extname(path))
  if (ext === '.md')
    return bundleFromMarkdown(readFileSync(path), name === 'SKILL' ? basename(dirname(path)) : name)
  return bundlesFromZip(readFileSync(path), name)
}

export function registerSkillsIpc(): void {
  ipcMain.handle(
    'skills:addPrepare',
    async (
      e,
      source: SkillSource,
      provider?: AgentProvider,
      projectPath?: string
    ): Promise<SkillPreview | { error: string } | null> => {
      if (!fromApp(e)) return null
      const p = toProvider(provider)
      try {
        const bundles = await readSource(source)
        if (!bundles) return null
        const targets = skillTargets(p, homedir(), projectPath)
        const token = randomUUID()
        // One waiting install at a time is all the panel ever has.
        pending.clear()
        pending.set(token, { bundles, provider: p, projectPath })
        return {
          token,
          canProject: !!targets.project,
          skills: bundles.map((b) => ({
            name: b.name,
            description: b.description,
            hasScripts: hasScripts(b),
            extraFiles: b.files.size - 1,
            exists: {
              global: alreadyThere(targets.global, b.name),
              project: !!targets.project && alreadyThere(targets.project, b.name)
            }
          }))
        }
      } catch (err) {
        return { error: err instanceof SkillError ? err.message : "Couldn't read that skill." }
      }
    }
  )
  ipcMain.handle(
    'skills:addInstall',
    async (
      e,
      token: string,
      where: 'global' | 'project',
      onConflict: OnConflict
    ): Promise<{ installed: string[] } | { error: string }> => {
      if (!fromApp(e)) return { error: 'Not allowed.' }
      const job = pending.get(token)
      if (!job) return { error: 'Choose the skill again.' }
      const targets = skillTargets(job.provider, homedir(), job.projectPath)
      const target = where === 'project' ? targets.project : targets.global
      if (!target) return { error: 'This agent has no project folder for skills.' }
      try {
        const installed = await installBundles(job.bundles, target, onConflict, trash)
        pending.delete(token)
        return { installed }
      } catch (err) {
        return { error: err instanceof SkillError ? err.message : "Couldn't install it." }
      }
    }
  )
  ipcMain.handle('skills:addCancel', (_e, token: string) => {
    pending.delete(token)
  })
  ipcMain.handle(
    'skills:remove',
    async (
      e,
      skill: { name: string; scope: 'global' | 'project'; kind: 'skill' | 'command' },
      provider?: AgentProvider,
      projectPath?: string
    ): Promise<{ ok: true } | { error: string }> => {
      if (!fromApp(e)) return { error: 'Not allowed.' }
      const path = removablePath(toProvider(provider), homedir(), projectPath, skill)
      if (!path) return { error: "This one can't be removed from here." }
      try {
        await trash(path)
        return { ok: true }
      } catch {
        return { error: "Couldn't move it to the Trash." }
      }
    }
  )
  ipcMain.handle('skills:list', (_e, projectPath?: string, provider?: AgentProvider) =>
    discoverSkills(projectPath, toProvider(provider))
  )
  ipcMain.handle('skills:installStarters', (_e, provider?: AgentProvider) => {
    const p = toProvider(provider)
    installStarterSkills(p)
    return discoverSkills(undefined, p)
  })
}
