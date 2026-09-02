/**
 * Tool names this build treats specially.
 *
 * Not a whitelist — an unknown tool is fine and common, the agent has many and
 * most need no handling here. This exists so drift can be noticed: when the app
 * special-cases a tool by name and that tool is renamed, nothing fails. No
 * error, no failed call. A feature just quietly stops being true.
 *
 * That is not hypothetical. 'Task' became 'Agent', and sub-agents stopped
 * appearing in "Running in background" for a whole release. The stored
 * transcripts said so the entire time — 27 calls to 'Agent', not one to 'Task' —
 * and nothing was reading them.
 *
 * `scripts/check-assumptions.mjs` reads this list and does exactly that: it asks
 * the transcripts which tools are really being called, and reports both
 * directions of drift. Keep this list honest and the check keeps working.
 */
export const KNOWN_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Monitor',
  'Task',
  'Agent',
  'TaskCreate',
  'TaskUpdate',
  'Edit',
  'Write',
  'MultiEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'ExitPlanMode',
  'ToolSearch',
  'Skill',
  'SendMessage',
  'ListAgents',
  'TaskOutput',
  'TaskStop',
  'Workflow',
  'Artifact'
] as const

/**
 * Tools whose absence from the transcripts is meaningful.
 *
 * Only names that actually appear in stored transcripts belong here, or the
 * check cries wolf on every run and stops being read. Deliberately excluded:
 *
 *   Edit, Write, MultiEdit   become `kind: "diff"` items, which carry the file
 *                            and the hunks but no tool name — invisible by
 *                            construction, not by absence
 *   BashOutput, KillShell    never reach the transcript at all (0 in ~13k tool
 *                            items); they are poll and cleanup calls the log
 *                            does not keep
 *
 * The app still special-cases all five. They simply cannot be verified this
 * way, and a check that reports them as missing is worse than one that admits
 * it cannot see them.
 */
export const LOAD_BEARING_TOOLS = ['Bash', 'Monitor', 'Agent', 'TaskCreate', 'TaskUpdate'] as const
