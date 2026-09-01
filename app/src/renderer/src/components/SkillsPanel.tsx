import { useEffect, useState } from 'react'
import { useStore } from '../state'
import { SectionView } from './SectionView'

interface Skill {
  name: string
  description: string
  scope: 'global' | 'project'
  kind: 'skill' | 'command'
}

interface SkillsPanelProps {
  workspaceId: string
  projectPath: string
  onClose: () => void
  /** Rendered inside a desktop window, which supplies the frame. */
  embedded?: boolean
}

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

  useEffect(() => {
    // setState lives inside the promise callback (not the synchronous effect body).
    window.cove.skillsList(projectPath, provider).then((list) => {
      setSkills(list)
      setLoading(false)
    })
  }, [projectPath, provider])

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
        : 'Turn what you just did into a reusable Claude Code skill: create a .claude/skills/<short-name>/SKILL.md in this project with proper frontmatter (name, description) and clear instructions so I can run it again later. Then tell me the skill name.'
    )
    onClose()
  }

  const installStarters = async (): Promise<void> => {
    const list = await window.cove.skillsInstallStarters(provider)
    setSkills(list)
  }

  return (
    <SectionView title="Skills" onClose={onClose} embedded={embedded}>
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
          <button key={s.name} className="skill-item" onClick={() => run(s)}>
            <div className="skill-item-top">
              <span className="skill-name">{s.kind === 'command' ? `/${s.name}` : s.name}</span>
              <span className={`skill-scope skill-scope-${s.scope}`}>{s.scope}</span>
            </div>
            {s.description && <span className="skill-desc">{s.description}</span>}
          </button>
        ))}
      </div>
      <div className="skills-footer">
        <button className="skills-action" onClick={saveAsSkill}>
          + Save last session as a skill
        </button>
      </div>
    </SectionView>
  )
}
