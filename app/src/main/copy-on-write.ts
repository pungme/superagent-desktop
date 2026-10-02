import { resolve, sep } from 'path'
import { cutRepo } from './chat-copy'
import { linkedRepos, repoAt, repoSetOf, repoSetRoot, setMembers } from './repo-set'

/**
 * A chat's copy of a folder of repos starts as links (repo-set.ts). This is
 * what turns one of them into the chat's own worktree at the moment a change to
 * it is about to happen — asked by the tool hooks, before the tool runs.
 *
 * It answers with a reason to hold the tool back, or null to let it through.
 * Holding it back is not a refusal: the repo has just been cut, and the agent
 * is told to do the same thing again, which now lands in its own worktree. The
 * call is not simply let through after the cut because the file it read a
 * moment ago was the project's checkout, unsaved changes and all, and the
 * worktree is cut from the last commit — an edit matched against the old text
 * would fail, or worse, match.
 *
 * Fail-open, like the gate it sits beside: a repo git will not cut stays a
 * link and the write goes to the shared checkout, as it did before chats had
 * copies at all. A stuck agent is the worse outcome.
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const cutNote = (name: string, branch: string, path: string): string =>
  `Not an error. Superagent has just given this conversation its own copy of \`${name}\`: ` +
  `${path} is now a git worktree on the branch \`${branch}\`, cut from the last commit, in ` +
  'place of the link to the shared checkout. Nothing was changed. Read the file again from ' +
  'that path (unsaved changes in the shared checkout are not in the copy) and repeat what you ' +
  'were doing.'

/**
 * Whether a shell command changes files, as far as can be told from its text.
 * It cannot be told in general — this catches the ordinary ways (git that
 * writes, a package manager installing, the file tools, a redirect into a
 * file) and the agent is asked to call `work_on_repo` first for the rest.
 */
export function writesFiles(command: string): boolean {
  const git =
    /\bgit\b(?:\s+-[cC]\s+\S+)*\s+(?:add|am|apply|branch\s+-[dDmMcC]|checkout|cherry-pick|clean|commit|merge|mv|pull|rebase|reset|restore|revert|rm|stash|switch|tag|worktree\s+(?:add|remove))\b/
  const tools =
    /(?:^\s*|[;&|(]\s*|\bsudo\s+|\bxargs\s+)(?:rm|mv|cp|mkdir|touch|tee|chmod|ln|patch|truncate)\b|\bsed\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i|\bperl\s+-[a-zA-Z]*i/m
  const packages =
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|remove|uninstall|update|upgrade|dedupe)\b|\b(?:pip3?|uv)\s+(?:install|sync|add)\b|\b(?:bundle|pod|cargo|go)\s+(?:install|update|add|get|mod\s+tidy)\b/
  // A redirect into a file: not 2>&1, not a here-string, not the bin.
  const redirect = /(?:^|[^0-9&<>=-])>>?(?![&>(=])\s*(?!\/dev\/)\S/m
  return (
    git.test(command) || tools.test(command) || packages.test(command) || redirect.test(command)
  )
}

const within = (dir: string, path: string): boolean => path === dir || path.startsWith(dir + sep)

/** The linked repos a shell command is about: the one it runs in, and any it
 *  names by path. */
function reposInCommand(setPath: string, command: string, cwd: string): string[] {
  const linked = linkedRepos(setPath)
  if (linked.length === 0) return []
  const root = repoSetRoot(setPath)
  const at = resolve(cwd)
  const out = new Set<string>()
  for (const name of linked) {
    if (within(resolve(setPath, name), at) || within(resolve(root, name), at)) out.add(name)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // As a path component: `cd api`, `api/src/x.ts`, `…/project/api`.
    if (new RegExp(`(?:^|[\\s"'=/(:])${escaped}(?:$|[\\s"'/;&|)])`, 'm').test(command))
      out.add(name)
  }
  return [...out].sort()
}

/**
 * Called before a tool runs. `chatCwd` is where the chat works, which is what
 * says whether it has a copy at all; `cwd` is where the tool is about to run,
 * when the hook knows — a shell that has stepped through a link reports the
 * project's own folder, which on its own looks like no copy.
 * Returns why the tool should not run as asked, or null.
 */
export async function copyBeforeWrite(
  toolName: string,
  input: unknown,
  chatCwd: string | undefined,
  toolCwd?: string
): Promise<string | null> {
  const setPath = repoSetOf(chatCwd) ?? repoSetOf(toolCwd)
  if (!setPath) return null
  const cwd = toolCwd || setPath
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

  if (EDIT_TOOLS.has(toolName)) {
    const target = str(args.file_path) || str(args.notebook_path)
    if (!target) return null
    const at = repoAt(setPath, target, cwd)
    if (!at) return null
    if (at.state === 'copied') {
      // Its own worktree exists and it reached past it, to the project's.
      return at.viaOriginal
        ? `That path is the shared checkout of \`${at.name}\`. This conversation has its own ` +
            `copy of it: make the change at ${at.inCopy} instead.`
        : null
    }
    const cut = await cutRepo(setPath, at.name)
    if (!cut.ok) return null
    return cutNote(at.name, cut.branch, at.inCopy)
  }

  if (toolName === 'Bash') {
    const command = str(args.command)
    if (!command || !writesFiles(command)) return null
    const done: string[] = []
    for (const name of reposInCommand(setPath, command, cwd)) {
      const cut = await cutRepo(setPath, name)
      if (cut.ok && cut.fresh) done.push(cutNote(name, cut.branch, cut.path))
    }
    return done.length ? done.join('\n') + '\nRun the command again from the copy.' : null
  }

  if (SEARCH_TOOLS.has(toolName)) {
    // Search does not follow a link it was not pointed at: from the top of the
    // copy it sees none of the repos the chat has not changed, and says "no
    // matches" as if it had looked.
    const linked = linkedRepos(setPath)
    if (linked.length === 0) return null
    const path = str(args.path)
    const where = path ? resolve(cwd, path) : resolve(cwd)
    if (where !== setPath) return null
    const copied = setMembers(setPath).map((m) => m.name)
    return (
      'Searching from the top of the working directory would miss most of this project: ' +
      `${linked.length} of its repositories are links here, and search does not look inside a ` +
      'link unless it is given one. Search one repository at a time by passing it as `path` ' +
      `(${[...copied, ...linked]
        .slice(0, 40)
        .map((n) => `\`${n}\``)
        .join(', ')}), or search all of them from the shell with \`rg --follow\` or \`grep -R\`.`
    )
  }
  return null
}
