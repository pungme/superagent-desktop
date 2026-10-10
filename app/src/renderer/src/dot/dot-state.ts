/**
 * What the dot is doing with one request, worked out from the chat's events.
 * Kept apart from the component so it can be tested as plain data: the same
 * events a phone receives go in, and what the dot shows comes out.
 */

export type DotStatus = 'working' | 'needs' | 'done' | 'failed'

export interface DotApproval {
  id: string
  toolName: string
  preview: string
  /**
   * A handoff is the agent stuck in the browser (a login, a captcha, a code
   * from your phone): something for you to do there, not an action to allow.
   */
  handoff: boolean
}

export interface DotTask {
  chatId: string
  workspaceId: string
  question: string
  startedAt: number
  status: DotStatus
  /** What it has done so far, newest last; the last is what it is doing now. */
  steps: string[]
  /** The answer as far as it has been written. */
  answer: string
  /** Text arriving for the block being written, before it lands as `answer`. */
  live: string
  approval: DotApproval | null
  /** Why it failed, when it did. */
  error: string
}

export function newTask(
  chatId: string,
  workspaceId: string,
  question: string,
  now: number
): DotTask {
  return {
    chatId,
    workspaceId,
    question,
    startedAt: now,
    status: 'working',
    steps: [],
    answer: '',
    live: '',
    approval: null,
    error: ''
  }
}

/**
 * A second question in the same conversation: what is shown starts over for
 * it, but it is the same chat, and it keeps an approval that is still waiting.
 */
export function followUp(task: DotTask, question: string, now: number): DotTask {
  return {
    ...task,
    question,
    startedAt: now,
    status: task.approval ? 'needs' : 'working',
    steps: [],
    answer: '',
    live: '',
    error: ''
  }
}

const TOOL_WORDS: Record<string, string> = {
  Bash: 'Running a command',
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  MultiEdit: 'Editing',
  Grep: 'Searching',
  Glob: 'Looking for files',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a page',
  Task: 'Working on a part of it',
  Agent: 'Working on a part of it',
  TodoWrite: 'Planning',
  // Superagent itself, driven by asking (main/app-tools.ts).
  app_find_chats: 'Looking for the chat',
  app_open_chat: 'Opening it',
  app_open_project: 'Opening the project',
  app_list_projects: 'Looking at your projects',
  app_status: 'Checking what is running',
  app_new_chat: 'Starting a chat',
  app_send_message: 'Sending a message',
  app_stop_chat: 'Stopping it',
  app_rename_chat: 'Renaming it',
  app_pin_chat: 'Pinning it',
  app_delete_chat: 'Deleting a chat',
  app_open_view: 'Opening',
  app_board: 'Reading the todo list',
  app_board_add: 'Adding to the todo list',
  app_board_move: 'Updating the todo list',
  app_routines: 'Looking at routines',
  app_routine: 'Changing a routine',
  // The Mac itself (main/computer-tools.ts).
  computer_screenshot: 'Looking at the screen',
  computer_read_ui: 'Reading the controls',
  computer_zoom: 'Looking closer',
  computer_wait: 'Waiting',
  computer_windows: 'Checking which apps are open',
  computer_click: 'Clicking',
  computer_move: 'Moving the pointer',
  computer_drag: 'Dragging',
  computer_scroll: 'Scrolling',
  computer_type: 'Typing',
  computer_key: 'Pressing',
  computer_open_mac_app: 'Opening'
}

/** A tool call as a few plain words: "Reading package.json", not "Read". */
export function stepLabel(name: string, detail: string): string {
  const short = name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')
  const words =
    TOOL_WORDS[short] ??
    short
      .replace(/_/g, ' ')
      .replace(/^(browser|sim|mail) /, (_m, p: string) =>
        p === 'sim' ? 'Simulator: ' : p === 'mail' ? 'Mail: ' : 'Browser: '
      )
  const d = detail.replace(/\s+/g, ' ').trim()
  // A file path says more as its last part; a command as its start.
  const tail = /^[~/.]/.test(d) && !d.includes(' ') ? (d.split('/').pop() ?? d) : d
  const cut = tail.length > 54 ? tail.slice(0, 53).trimEnd() + '…' : tail
  return cut ? `${words} ${words.endsWith(':') ? '' : '· '}${cut}`.replace(':  ', ': ') : words
}

const MAX_STEPS = 40

/** One of the chat's events applied to the task. Events for another chat change nothing. */
export function applyEvent(task: DotTask, chatId: string, data: Record<string, unknown>): DotTask {
  if (chatId !== task.chatId) return task
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (data.kind) {
    case 'tool': {
      const label = stepLabel(s(data.name), s(data.detail))
      if (task.steps[task.steps.length - 1] === label) return { ...task, live: '' }
      return { ...task, steps: [...task.steps, label].slice(-MAX_STEPS), live: '' }
    }
    case 'assistant':
      // Each finished block of the reply; the last is the answer.
      return s(data.text).trim() ? { ...task, answer: s(data.text).trim(), live: '' } : task
    case 'notice':
      return s(data.text)
        ? { ...task, steps: [...task.steps, s(data.text)].slice(-MAX_STEPS) }
        : task
    case 'approval':
      return {
        ...task,
        status: 'needs',
        approval: {
          id: s(data.id),
          toolName: s(data.toolName),
          preview: s(data.preview),
          handoff: data.approvalKind === 'handoff'
        }
      }
    case 'approval_end':
      return task.approval?.id === s(data.id)
        ? { ...task, status: task.status === 'needs' ? 'working' : task.status, approval: null }
        : task
    case 'turn_end': {
      const ok = data.ok !== false
      return {
        ...task,
        status: ok ? 'done' : 'failed',
        approval: null,
        live: '',
        answer: task.answer || task.live.trim(),
        error: ok
          ? ''
          : s(data.subtype) === 'interrupted'
            ? 'Stopped.'
            : 'It stopped before finishing.'
      }
    }
    default:
      return task
  }
}

/** Text streaming in for the block being written. */
export function applyDelta(task: DotTask, chatId: string, text: string): DotTask {
  if (chatId !== task.chatId || task.status === 'done' || task.status === 'failed') return task
  return { ...task, live: task.live + text }
}

/** "42s", "3m 05s": how long it has been at it. */
export function elapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}

/**
 * What to offer before anything is typed: the things the agent can do on this
 * Mac from a sentence, for the Computer; the questions worth asking of a
 * project, for a project.
 */
export function suggestions(kind: string): string[] {
  if (kind === 'computer')
    return [
      "What's using the most memory right now?",
      'Tidy my Downloads folder',
      "What's on my calendar today?",
      'Summarise my unread email',
      'Find the PDF I downloaded this week',
      'How much disk space is left, and what is using it?',
      "What's using port 3000?",
      'Look this up on the web for me: ',
      'Draft a reply to my last email'
    ]
  return [
    'What changed here this week?',
    'Is anything failing right now?',
    'Run the tests and tell me what breaks',
    'What should I work on next?',
    'Explain how this project is put together'
  ]
}
