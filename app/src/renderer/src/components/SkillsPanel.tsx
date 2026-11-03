import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state'
import { SectionView } from './SectionView'
import { PROVIDER_PRODUCT } from '../../../shared/agent-provider'

interface Skill {
  name: string
  description: string
  scope: 'global' | 'project' | 'claude.ai'
  kind: 'skill' | 'command'
}

type Preview = Extract<Awaited<ReturnType<typeof window.cove.skillsAddPrepare>>, { token: string }>
type Source = Parameters<typeof window.cove.skillsAddPrepare>[0]

interface SkillsPanelProps {
  workspaceId: string
  projectPath: string
  onClose: () => void
  /** Rendered inside a desktop window, which supplies the frame. */
  embedded?: boolean
}

/** Told to every composer, so "/" offers a skill as soon as it is added. */
export const SKILLS_CHANGED = 'cove:skills-changed'

/** Removable from here: the user's own folders, and a project's skills folder (not its other files). */
const removable = (s: Skill): boolean =>
  s.scope !== 'claude.ai' && (s.scope === 'global' || s.kind === 'skill')

export function SkillsPanel({
  workspaceId,
  projectPath,
  onClose,
  embedded = false
}: SkillsPanelProps): React.JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const sendToClaude = useStore((s) => s.sendToClaude)
  // The panel is per project, not per chat, so it shows the default agent's
  // skills — the ones a new chat here would be able to run.
  const provider = useStore((s) => s.provider)

  const [menuOpen, setMenuOpen] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [where, setWhere] = useState<'global' | 'project'>('global')
  const [removing, setRemoving] = useState<Skill | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // setState lives inside the promise callback (not the synchronous effect body).
    window.cove.skillsList(projectPath, provider).then((list) => {
      setSkills(list)
      setLoading(false)
    })
  }, [projectPath, provider])

  useEffect(() => {
    if (!menuOpen) return
    const away = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menuOpen])

  const refresh = async (): Promise<void> => {
    setSkills(await window.cove.skillsList(projectPath, provider))
    window.dispatchEvent(new Event(SKILLS_CHANGED))
  }

  const run = (skill: Skill): void => {
    // Commands are slash-invocable; skills are invoked by asking the agent to use them.
    const message = skill.kind === 'command' ? `/${skill.name}` : `Use the "${skill.name}" skill.`
    sendToClaude(workspaceId, message)
    onClose()
  }

  const saveAsSkill = (): void => {
    sendToClaude(
      workspaceId,
      provider === 'codex'
        ? 'Turn what you just did into a reusable prompt: create a .codex/prompts/<short-name>.md in this project with clear instructions so I can run it again later with /<short-name>. Then tell me its name.'
        : provider === 'antigravity'
          ? 'Turn what you just did into a reusable Antigravity skill: create a .agents/skills/<short-name>/SKILL.md in this project with proper frontmatter (name, description) and clear instructions so I can run it again later. Then tell me the skill name.'
          : 'Turn what you just did into a reusable Claude Code skill: create a .claude/skills/<short-name>/SKILL.md in this project with proper frontmatter (name, description) and clear instructions so I can run it again later. Then tell me the skill name.'
    )
    onClose()
  }

  const installStarters = async (): Promise<void> => {
    const list = await window.cove.skillsInstallStarters(provider)
    setSkills(list)
    window.dispatchEvent(new Event(SKILLS_CHANGED))
  }

  const closeSheet = (): void => {
    if (preview) void window.cove.skillsAddCancel(preview.token)
    setPreview(null)
    setLink(null)
    setError('')
    setBusy('')
  }

  const read = async (source: Source): Promise<void> => {
    setMenuOpen(false)
    setError('')
    setBusy(source.kind === 'link' ? 'Downloading…' : 'Reading…')
    const result = await window.cove.skillsAddPrepare(source, provider, projectPath)
    setBusy('')
    if (!result) return // the picker was cancelled
    if ('error' in result) {
      setError(result.error)
      return
    }
    setLink(null)
    setWhere('global')
    setPreview(result)
  }

  const install = async (onConflict: 'replace' | 'keep-both' | 'none'): Promise<void> => {
    if (!preview) return
    setBusy('Installing…')
    const result = await window.cove.skillsAddInstall(preview.token, where, onConflict)
    setBusy('')
    if ('error' in result) {
      setError(result.error)
      return
    }
    setPreview(null)
    setError('')
    await refresh()
  }

  const remove = async (): Promise<void> => {
    // A claude.ai skill is changed on claude.ai: it never offers Remove.
    if (!removing || removing.scope === 'claude.ai') return
    const result = await window.cove.skillsRemove(
      { name: removing.name, scope: removing.scope, kind: removing.kind },
      provider,
      projectPath
    )
    if ('error' in result) setError(result.error)
    setRemoving(null)
    await refresh()
  }

  const agent = PROVIDER_PRODUCT[provider]
  const clashes = preview?.skills.filter((s) => s.exists[where]) ?? []
  const scripts = preview?.skills.some((s) => s.hasScripts && provider !== 'codex')
  const dropped = provider === 'codex' && preview?.skills.some((s) => s.extraFiles > 0)
  const sheetOpen = !!preview || link !== null || !!removing || (!!error && !preview)

  return (
    <SectionView title="Skills" onClose={onClose} embedded={embedded}>
      <div className="skills-wrap">
        <div className="skills-list">
          {loading && <div className="skills-empty">Loading…</div>}
          {!loading && skills.length === 0 && (
            <div className="skills-empty">
              <p>No skills yet.</p>
              <button className="skills-action" onClick={installStarters}>
                Add starter skills
              </button>
            </div>
          )}
          {skills.map((s) => (
            <div key={s.name} className="skill-card">
              <button className="skill-item" onClick={() => run(s)}>
                <div className="skill-item-top">
                  <span className="skill-name">{s.kind === 'command' ? `/${s.name}` : s.name}</span>
                  <span
                    className={`skill-scope skill-scope-${s.scope === 'claude.ai' ? 'claude' : s.scope}`}
                    title={
                      s.scope === 'claude.ai'
                        ? 'From your claude.ai account, kept in sync by Claude Code. Change it on claude.ai.'
                        : undefined
                    }
                  >
                    {s.scope}
                  </span>
                </div>
                {s.description && <span className="skill-desc">{s.description}</span>}
              </button>
              {removable(s) && (
                <button
                  className="skill-remove"
                  title={`Remove ${s.name}`}
                  onClick={() => setRemoving(s)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="skills-footer">
          <div className="skills-add" ref={menuRef}>
            <button
              className="skills-action"
              onClick={() => setMenuOpen((o) => !o)}
              disabled={!!busy}
            >
              {busy && !preview ? busy : '+ Add skill'}
            </button>
            {menuOpen && (
              <div className="skills-add-menu" role="menu">
                <button role="menuitem" onClick={() => void read({ kind: 'folder' })}>
                  From a folder…
                </button>
                <button role="menuitem" onClick={() => void read({ kind: 'file' })}>
                  From a .zip or .skill file…
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setError('')
                    setLink('')
                  }}
                >
                  From a link…
                </button>
              </div>
            )}
          </div>
          <button className="skills-action" onClick={saveAsSkill}>
            + Save last session as a skill
          </button>
        </div>

        {sheetOpen && (
          <div
            className="skill-sheet-backdrop"
            onMouseDown={(e) =>
              e.target === e.currentTarget && (removing ? setRemoving(null) : closeSheet())
            }
          >
            <div className="skill-sheet" role="dialog" aria-label="Add skill">
              {removing ? (
                <>
                  <div className="skill-sheet-title">Move “{removing.name}” to the Trash?</div>
                  <p className="skill-sheet-note">
                    {agent} won’t offer it any more. You can put it back from the Trash.
                  </p>
                  <div className="skill-sheet-buttons">
                    <button onClick={() => setRemoving(null)}>Cancel</button>
                    <button className="primary" onClick={() => void remove()}>
                      Move to Trash
                    </button>
                  </div>
                </>
              ) : preview ? (
                <>
                  <div className="skill-sheet-title">
                    Add {preview.skills.length === 1 ? 'skill' : `${preview.skills.length} skills`}{' '}
                    to {agent}
                  </div>
                  <ul className="skill-sheet-list">
                    {preview.skills.map((s) => (
                      <li key={s.name}>
                        <span className="skill-name">{s.name}</span>
                        {s.description && <span className="skill-desc">{s.description}</span>}
                      </li>
                    ))}
                  </ul>
                  {preview.canProject ? (
                    <div className="skill-sheet-where" role="radiogroup" aria-label="Where">
                      <button
                        role="radio"
                        aria-checked={where === 'global'}
                        className={where === 'global' ? 'on' : ''}
                        onClick={() => setWhere('global')}
                      >
                        All projects
                      </button>
                      <button
                        role="radio"
                        aria-checked={where === 'project'}
                        className={where === 'project' ? 'on' : ''}
                        onClick={() => setWhere('project')}
                      >
                        This project
                      </button>
                    </div>
                  ) : (
                    <p className="skill-sheet-note">{agent} uses it in all projects.</p>
                  )}
                  {dropped && (
                    <p className="skill-sheet-note">
                      Codex gets the instructions only. The skill’s other files are not copied.
                    </p>
                  )}
                  {scripts && (
                    <p className="skill-sheet-warning">
                      This skill includes scripts the agent can run. Install only skills you trust.
                    </p>
                  )}
                  {clashes.length > 0 && (
                    <p className="skill-sheet-note">
                      {clashes.length === 1
                        ? `A skill named “${clashes[0].name}” is already there.`
                        : `${clashes.length} of these are already there.`}
                    </p>
                  )}
                  {error && <p className="skill-sheet-error">{error}</p>}
                  <div className="skill-sheet-buttons">
                    <button onClick={closeSheet}>Cancel</button>
                    {clashes.length > 0 ? (
                      <>
                        <button onClick={() => void install('keep-both')} disabled={!!busy}>
                          Keep both
                        </button>
                        <button
                          className="primary"
                          onClick={() => void install('replace')}
                          disabled={!!busy}
                        >
                          Replace
                        </button>
                      </>
                    ) : (
                      <button
                        className="primary"
                        onClick={() => void install('none')}
                        disabled={!!busy}
                      >
                        {busy || 'Install'}
                      </button>
                    )}
                  </div>
                </>
              ) : link !== null ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (link.trim()) void read({ kind: 'link', url: link.trim() })
                  }}
                >
                  <div className="skill-sheet-title">Add a skill from a link</div>
                  <input
                    className="skill-sheet-input"
                    autoFocus
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    placeholder="https://github.com/…"
                    aria-label="Link"
                  />
                  <p className="skill-sheet-note">
                    A GitHub repo, a folder in one, or a SKILL.md. Public repos only.
                  </p>
                  {error && <p className="skill-sheet-error">{error}</p>}
                  <div className="skill-sheet-buttons">
                    <button type="button" onClick={closeSheet}>
                      Cancel
                    </button>
                    <button type="submit" className="primary" disabled={!link.trim() || !!busy}>
                      {busy || 'Continue'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="skill-sheet-title">Couldn’t add that skill</div>
                  <p className="skill-sheet-error">{error}</p>
                  <div className="skill-sheet-buttons">
                    <button className="primary" onClick={closeSheet}>
                      OK
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </SectionView>
  )
}
