import { useEffect, useRef, useState, useCallback } from 'react'
import { useStore, TodoItem } from '../state'
import { TasksPanel } from './TasksPanel'
import { Markdown } from './Markdown'
import { useDictation } from '../lib/dictation'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  images?: string[] // data URLs, for user messages
  replyTo?: { role: 'user' | 'assistant'; text: string } // WhatsApp-style quoted message
}

interface PendingImage {
  mediaType: string
  data: string // base64 (no data-URL prefix)
  url: string // data URL for preview
}

interface ToolCall {
  id: string
  name: string
  detail: string
}

interface DiffHunk {
  removed: string[]
  added: string[]
}

interface FileDiff {
  id: string
  file: string
  hunks: DiffHunk[]
}

type Item =
  | { kind: 'msg'; msg: ChatMessage }
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'diff'; diff: FileDiff }
  | { kind: 'thinking'; id: string; text: string }

interface EasyChatProps {
  cwd: string
  workspaceId: string
  /** Which of the project's conversations this is. Owns the transcript + session. */
  chatId: string
  initialSessionId?: string | null
  browserProject?: boolean
}

// Drop lines shared by the start/end of both sides so only the real change shows.
function trimCommon(removed: string[], added: string[]): DiffHunk {
  let start = 0
  while (start < removed.length && start < added.length && removed[start] === added[start]) start++
  let endR = removed.length
  let endA = added.length
  while (endR > start && endA > start && removed[endR - 1] === added[endA - 1]) {
    endR--
    endA--
  }
  return { removed: removed.slice(start, endR), added: added.slice(start, endA) }
}

// Build a diff card from an Edit/Write/MultiEdit tool's input (returns null for other tools).
function toolDiff(name: string, id: string, input: unknown): FileDiff | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const file = typeof o.file_path === 'string' ? (o.file_path.split('/').pop() ?? '') : ''
  // Drop one trailing newline so a spurious empty "+"/"-" line isn't shown.
  const lines = (s: unknown): string[] =>
    typeof s === 'string' && s ? s.replace(/\n$/, '').split('\n') : []
  if (name === 'Edit' && (o.old_string || o.new_string)) {
    return { id, file, hunks: [trimCommon(lines(o.old_string), lines(o.new_string))] }
  }
  if (name === 'Write' && o.content) {
    return { id, file, hunks: [{ removed: [], added: lines(o.content) }] }
  }
  if (name === 'MultiEdit' && Array.isArray(o.edits)) {
    const hunks = (o.edits as Record<string, unknown>[]).map((e) =>
      trimCommon(lines(e.old_string), lines(e.new_string))
    )
    return { id, file, hunks }
  }
  return null
}

/** Monochrome line icon, matching the sidebar's — currentColor, no emoji. */
function MicIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
      <path d="M3.6 7.2v.8a4.4 4.4 0 0 0 8.8 0v-.8" />
      <path d="M8 12.4v1.8" />
    </svg>
  )
}

// Short verb + icon for the noisy internal tool names.
function toolLabel(name: string): { icon: string; verb: string } {
  if (name.startsWith('mcp__cove-browser__browser_')) {
    const action = name.replace('mcp__cove-browser__browser_', '').replace(/_/g, ' ')
    return { icon: '🌐', verb: action }
  }
  const map: Record<string, { icon: string; verb: string }> = {
    Bash: { icon: '⌘', verb: 'Running' },
    Read: { icon: '📄', verb: 'Reading' },
    Edit: { icon: '✏️', verb: 'Editing' },
    Write: { icon: '✏️', verb: 'Writing' },
    MultiEdit: { icon: '✏️', verb: 'Editing' },
    Glob: { icon: '🔎', verb: 'Finding files' },
    Grep: { icon: '🔎', verb: 'Searching' },
    WebFetch: { icon: '🌐', verb: 'Fetching' },
    WebSearch: { icon: '🔎', verb: 'Searching the web' },
    TodoWrite: { icon: '✓', verb: 'Planning' },
    Task: { icon: '🤖', verb: 'Sub-agent' },
    ToolSearch: { icon: '🧰', verb: 'Finding tools' }
  }
  return map[name] ?? { icon: '🔧', verb: name }
}

// Pull the most meaningful field out of a tool's input for a one-line detail.
// A ToolSearch "select:a,b,c" query → a short, human list ("browser navigate, …").
function friendlyToolNames(select: string): string {
  const names = select
    .replace(/^select:/, '')
    .split(',')
    .map((n) =>
      n
        .trim()
        .replace(/^mcp__[a-z0-9-]+__/i, '')
        .replace(/_/g, ' ')
    )
    .filter(Boolean)
  const shown = names.slice(0, 3).join(', ')
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown
}

function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = o.query ?? o.url ?? o.pattern ?? o.command ?? o.prompt ?? o.description ?? o.text
  if (typeof pick === 'string') {
    if (pick.startsWith('select:')) return friendlyToolNames(pick)
    return pick.replace(/\s+/g, ' ').trim().slice(0, 70)
  }
  if (typeof o.file_path === 'string') return o.file_path.split('/').pop() ?? ''
  return ''
}

// Any run of 2+ collapses to one line. Runs only group *consecutive* tool calls, so
// interleaved text/thinking splits them into short fragments — a higher threshold
// left most of those expanded, which is the noise this is meant to hide.
const TOOL_COLLAPSE_MIN = 2

// "Running ×9 · Reading ×6" — distinct verbs in first-seen order, so the collapsed
// row still says what the agent actually did.
function summarizeTools(tools: ToolCall[]): string {
  const counts = new Map<string, number>()
  for (const t of tools) {
    const { verb } = toolLabel(t.name)
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  const parts = [...counts].map(([verb, n]) => (n > 1 ? `${verb} ×${n}` : verb))
  return parts.slice(0, 3).join(' · ') + (parts.length > 3 ? ' · …' : '')
}

// One thing the agent did — a tool call or a file edit. A run of these (only
// broken by a real message) collapses into a single ActivityStrip.
type Activity = { kind: 'tool'; tool: ToolCall } | { kind: 'diff'; diff: FileDiff }

function toolChip(t: ToolCall, cls: string, key: string): React.JSX.Element {
  const { icon, verb } = toolLabel(t.name)
  return (
    <span key={key} className={cls} title={t.detail}>
      <span className="easy-tool-icon">{icon}</span>
      <span className="easy-tool-verb">{verb}</span>
      {t.detail && <span className="easy-tool-detail">{t.detail}</span>}
    </span>
  )
}

function ActivityStrip({ entries }: { entries: Activity[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  // A lone entry reads fine on its own — a chip for a tool, a card for an edit.
  if (entries.length < TOOL_COLLAPSE_MIN) {
    const e = entries[0]
    if (!e) return <></>
    return e.kind === 'diff' ? (
      <DiffCard diff={e.diff} />
    ) : (
      <div className="easy-tools">{toolChip(e.tool, 'easy-tool', e.tool.id)}</div>
    )
  }

  const tools = entries.flatMap((e) => (e.kind === 'tool' ? [e.tool] : []))
  const edits = entries.filter((e) => e.kind === 'diff').length
  const parts: string[] = []
  if (tools.length) parts.push(`${tools.length} step${tools.length > 1 ? 's' : ''}`)
  if (edits) parts.push(`${edits} edit${edits > 1 ? 's' : ''}`)

  return (
    <div className="easy-toolgroup">
      <button
        className="easy-tools-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? 'Hide steps' : 'Show steps'}
      >
        <span className={'easy-tools-caret' + (open ? ' is-open' : '')}>›</span>
        <span className="easy-tools-count">{parts.join(' · ')}</span>
        {!open && tools.length > 0 && (
          <span className="easy-tools-summary">{summarizeTools(tools)}</span>
        )}
      </button>
      {open && (
        <div className="easy-toollist">
          {entries.map((e, i) =>
            e.kind === 'diff' ? (
              <DiffCard key={'d' + i} diff={e.diff} />
            ) : (
              toolChip(e.tool, 'easy-toolrow', e.tool.id + i)
            )
          )}
        </div>
      )}
    </div>
  )
}

// A file edit — collapsed to one line by default so the chat isn't flooded with
// diffs; click to see the actual change.
function DiffCard({ diff }: { diff: FileDiff }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const added = diff.hunks.reduce((n, h) => n + h.added.length, 0)
  const removed = diff.hunks.reduce((n, h) => n + h.removed.length, 0)
  return (
    <div className="easy-diff">
      <button className="easy-diff-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={'easy-diff-caret' + (open ? ' is-open' : '')}>›</span>
        <span className="easy-diff-file">✏️ {diff.file}</span>
        <span className="easy-diff-stat">
          {added > 0 && <span className="easy-diff-plus">+{added}</span>}
          {removed > 0 && <span className="easy-diff-minus">−{removed}</span>}
        </span>
      </button>
      {open && (
        <pre className="easy-diff-body">
          {diff.hunks.map((h, hi) => (
            <span key={hi}>
              {h.removed.map((l, li) => (
                <span key={'r' + li} className="easy-diff-del">
                  - {l}
                  {'\n'}
                </span>
              ))}
              {h.added.map((l, li) => (
                <span key={'a' + li} className="easy-diff-add">
                  + {l}
                  {'\n'}
                </span>
              ))}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

type Row =
  | { kind: 'msg'; msg: ChatMessage }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'activity'; entries: Activity[] }

// A whole working segment — tool calls AND file edits, in order — collapses into
// one strip. Only a real message breaks the run; thinking is ambient narration,
// so it never ends the run (otherwise one batch fragments into tiny strips).
function toRows(items: Item[]): Row[] {
  const rows: Row[] = []
  const runTarget = (): Row | undefined => {
    let i = rows.length - 1
    while (i >= 0 && rows[i].kind === 'thinking') i--
    return rows[i]
  }
  for (const it of items) {
    if (it.kind === 'tool' || it.kind === 'diff') {
      const entry: Activity = it.kind === 'tool' ? { kind: 'tool', tool: it.tool } : { kind: 'diff', diff: it.diff }
      const target = runTarget()
      if (target && target.kind === 'activity') target.entries.push(entry)
      else rows.push({ kind: 'activity', entries: [entry] })
    } else {
      rows.push(it)
    }
  }
  return rows
}

export function EasyChat({
  cwd,
  workspaceId,
  chatId,
  initialSessionId,
  browserProject
}: EasyChatProps): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [ready, setReady] = useState(false)
  const [agentFailed, setAgentFailed] = useState(false)
  const [generating, setGenerating] = useState(false)
  // Messages typed while a turn is streaming are queued here and sent in order
  // as each turn finishes (stacking), rather than blocked.
  const queueRef = useRef<{ text: string; images: PendingImage[] }[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [resetKey, setResetKey] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [commands, setCommands] = useState<string[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionKind, setMentionKind] = useState<'file' | 'cmd'>('file')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [atBottom, setAtBottom] = useState(true)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [dragOver, setDragOver] = useState(false)
  // WhatsApp-style quote-reply: the message the next send will reply to.
  const [replyTarget, setReplyTarget] = useState<{ role: 'user' | 'assistant'; text: string } | null>(
    null
  )
  const swipeRef = useRef<{ x: number; y: number; el: HTMLElement } | null>(null)
  const agentIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamingIdRef = useRef<string | null>(null)
  const thinkingIdRef = useRef<string | null>(null)
  // Session to resume so context survives restarts; updated once claude reports it.
  const resumeIdRef = useRef<string | null>(initialSessionId ?? null)
  // True once a resume-based retry has already failed, so the next retry drops the
  // resume and starts fresh (a crashed session can leave a stale lock that keeps
  // failing to resume, which would otherwise loop the Retry button).
  const resumeRetriedRef = useRef(false)
  // Naming happens once per chat, so a rename is never clobbered by a late
  // suggestion; the placeholder is the only title we'll overwrite.
  const aiTitledRef = useRef(false)
  const placeholderTitleRef = useRef<string | null>(null)
  // No per-chat reset needed here: WorkspaceView keys this component by chat id,
  // so switching conversations mounts a fresh one with these refs re-initialised
  // from the incoming chat's own session.
  const registerAgent = useStore((s) => s.registerAgent)
  const isActive = useStore((s) => s.activeWorkspaceId === workspaceId)

  // Elapsed "Working Ns" timer while a turn is running. (Reset happens in the
  // event handlers that clear `generating`, so no synchronous setState here.)
  useEffect(() => {
    if (!generating) return
    const start = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500)
    return () => clearInterval(t)
  }, [generating])

  // Load files (@-mentions) and skills/commands (/-commands) once.
  useEffect(() => {
    window.cove.filesList(cwd).then(setFiles)
    window.cove.skillsList(cwd).then((list) => setCommands(list.map((s) => s.name)))
  }, [cwd])

  // Restore the persisted transcript on mount, then save it (debounced) as it
  // changes — so the conversation is still here after SuperAgent is reopened.
  const hydratedRef = useRef(false)
  useEffect(() => {
    let alive = true
    // Saving stays blocked until this chat's own transcript has landed, so an
    // empty first render can never be written over real data.
    hydratedRef.current = false
    window.cove.chatLoad(chatId).then((json) => {
      if (!alive) return
      if (json) {
        try {
          const saved = JSON.parse(json) as Item[]
          if (saved.length) setItems(saved)
        } catch {
          // Ignore a corrupt blob — start fresh.
        }
      }
      hydratedRef.current = true
    })
    return () => {
      alive = false
    }
  }, [chatId])

  useEffect(() => {
    // Never write without a chat to write to, and never before this chat's own
    // transcript has loaded — either would persist an empty list over real data.
    if (!chatId || !hydratedRef.current) return
    const t = setTimeout(() => {
      // Persist a clean copy — no mid-stream flags to reanimate on reload.
      const clean = items.map((it) =>
        it.kind === 'msg' && it.msg.streaming ? { ...it, msg: { ...it.msg, streaming: false } } : it
      )
      window.cove.chatSave(chatId, JSON.stringify(clean))
    }, 400)
    return () => clearTimeout(t)
  }, [items, chatId])

  // Paste a screenshot/image into the composer.
  const attachImage = (file: File): void => {
    const reader = new FileReader()
    reader.onload = (): void => {
      const url = reader.result as string
      const data = url.split(',')[1] ?? ''
      setPendingImages((prev) => [...prev, { mediaType: file.type, data, url }])
    }
    reader.readAsDataURL(file)
  }

  // Cmd+V an image anywhere in the active chat (not only when the input is
  // focused) — a document-level listener, scoped to the visible workspace.
  useEffect(() => {
    if (!isActive) return
    const onDocPaste = (e: ClipboardEvent): void => {
      const imgItems = [...(e.clipboardData?.items ?? [])].filter((it) =>
        it.type.startsWith('image/')
      )
      if (imgItems.length === 0) return // let normal text paste happen
      e.preventDefault()
      for (const item of imgItems) {
        const file = item.getAsFile()
        if (file) attachImage(file)
      }
    }
    document.addEventListener('paste', onDocPaste)
    return () => document.removeEventListener('paste', onDocPaste)
    // attachImage only closes over stable setState, so re-subscribing per render is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  // Drag a file onto the chat: images attach (like a paste); other files insert
  // their absolute path so Claude can read them.
  const onDrop = (e: React.DragEvent): void => {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    e.preventDefault()
    setDragOver(false)
    const paths: string[] = []
    for (const file of files) {
      if (file.type.startsWith('image/')) attachImage(file)
      else {
        const p = window.cove.getPathForFile?.(file)
        if (p) paths.push(p)
      }
    }
    if (paths.length > 0) {
      setInput((prev) => (prev ? prev.trimEnd() + ' ' : '') + paths.join(' ') + ' ')
      requestAnimationFrame(autoResize)
      inputRef.current?.focus()
    }
  }

  // Track the drop-hint from the window so it can't get stuck: show it only while a
  // file is dragged over THIS chat, and always clear it on drop/leave/end.
  useEffect(() => {
    const onOver = (e: DragEvent): void => {
      const overChat = !!e.target && chatRef.current?.contains(e.target as Node)
      setDragOver(!!overChat && !!e.dataTransfer?.types.includes('Files'))
    }
    const clear = (): void => setDragOver(false)
    const onLeave = (e: DragEvent): void => {
      if (e.relatedTarget === null) setDragOver(false) // pointer left the window
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    window.addEventListener('dragleave', onLeave)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('dragleave', onLeave)
    }
  }, [])

  // Grow the input with its content, up to the CSS max-height.
  const autoResize = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  // Insert a file reference (clicked in the file tree) into the composer — don't send.
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { workspaceId: string; text: string }
      if (detail.workspaceId !== workspaceId) return
      setInput((prev) => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + detail.text)
      const el = inputRef.current
      if (el) {
        el.focus()
        requestAnimationFrame(() => {
          el.style.height = 'auto'
          el.style.height = Math.min(el.scrollHeight, 160) + 'px'
        })
      }
    }
    window.addEventListener('cove:insert-reference', onInsert)
    return () => window.removeEventListener('cove:insert-reference', onInsert)
  }, [workspaceId])

  // Detect a "/command" at the start, or an "@file" at the caret, for the dropdown.
  const updateMention = (value: string): void => {
    const cmd = /^\/(\S*)$/.exec(value)
    if (cmd) {
      setMentionKind('cmd')
      setMentionQuery(cmd[1])
      setMentionIndex(0)
      return
    }
    const el = inputRef.current
    const caret = el ? el.selectionStart : value.length
    const m = /(^|\s)@([\w./-]*)$/.exec(value.slice(0, caret))
    setMentionKind('file')
    setMentionQuery(m ? m[2] : null)
    setMentionIndex(0)
  }

  const mentionMatches =
    mentionQuery === null
      ? []
      : (() => {
          const pool = mentionKind === 'cmd' ? commands : files
          const q = mentionQuery.toLowerCase()
          return (q === '' ? pool : pool.filter((f) => f.toLowerCase().includes(q))).slice(0, 8)
        })()

  const pickMention = (item: string): void => {
    if (mentionKind === 'cmd') {
      setInput(`/${item} `)
    } else {
      // Replace the trailing "@query" with "@path ".
      setInput((prev) => prev.replace(/@[\w./-]*$/, `@${item} `))
    }
    setMentionQuery(null)
    inputRef.current?.focus()
  }

  const dictation = useDictation()
  const micTitle =
    dictation.state === 'recording'
      ? 'Listening — release to transcribe'
      : dictation.state === 'loading-model'
        ? 'Preparing the speech model (first time only)…'
        : dictation.state === 'transcribing'
          ? 'Transcribing…'
          : 'Hold to dictate (⌥Space)'

  // Latest transcript for callbacks that must not re-subscribe on every message.
  const itemsRef = useRef<Item[]>(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const nameConversation = useCallback(async (): Promise<void> => {
    const store = useStore.getState()
    const chat = store.chats[workspaceId]?.find((c) => c.id === chatId)
    // Only replace our own placeholder — anything else is the user's wording.
    if (!chat || (chat.title && chat.title !== placeholderTitleRef.current)) return

    const firstUser = itemsRef.current.find((it) => it.kind === 'msg' && it.msg.role === 'user')
    const firstReply = itemsRef.current.find(
      (it) => it.kind === 'msg' && it.msg.role === 'assistant' && it.msg.text.trim()
    )
    if (!firstUser || firstUser.kind !== 'msg') return
    const excerpt =
      `User: ${firstUser.msg.text.slice(0, 600)}` +
      (firstReply && firstReply.kind === 'msg'
        ? `\n\nAssistant: ${firstReply.msg.text.slice(0, 600)}`
        : '')

    const title = await window.cove.agentSuggestTitle(cwd, excerpt)
    if (!title) return
    const latest = useStore.getState().chats[workspaceId]?.find((c) => c.id === chatId)
    if (latest && latest.title !== placeholderTitleRef.current) return // renamed while we waited
    window.cove.chatUpdate(chatId, { title })
    useStore.getState().touchChat(workspaceId, chatId, { title })
  }, [cwd, workspaceId, chatId])

  const handleEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = event.type as string

      if (type === 'system' && (event.subtype as string) === 'init') {
        setReady(true)
        // Remember the session id so we can resume this conversation next launch.
        const sid = event.session_id as string | undefined
        if (sid && sid !== resumeIdRef.current) {
          resumeIdRef.current = sid
          window.cove.chatUpdate(chatId, { claudeSessionId: sid })
          useStore.getState().touchChat(workspaceId, chatId, { claudeSessionId: sid })
        }
        return
      }

      if (type === 'stream_event') {
        const ev = event.event as Record<string, unknown>
        const evType = ev?.type as string
        if (evType === 'content_block_start') {
          const block = ev.content_block as Record<string, unknown>
          if (block?.type === 'text') {
            // Begin a new streaming assistant message.
            const id = `a-${Date.now()}-${Math.random()}`
            streamingIdRef.current = id
            setThinking(false)
            setItems((prev) => [
              ...prev,
              { kind: 'msg', msg: { id, role: 'assistant', text: '', streaming: true } }
            ])
          } else if (block?.type === 'thinking') {
            const id = `t-${Date.now()}-${Math.random()}`
            thinkingIdRef.current = id
            setItems((prev) => [...prev, { kind: 'thinking', id, text: '' }])
          }
        } else if (evType === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown>
          if (delta?.type === 'text_delta') {
            const sid = streamingIdRef.current
            const chunk = delta.text as string
            setItems((prev) =>
              prev.map((it) =>
                it.kind === 'msg' && it.msg.id === sid
                  ? { ...it, msg: { ...it.msg, text: it.msg.text + chunk } }
                  : it
              )
            )
          } else if (delta?.type === 'thinking_delta') {
            const tid = thinkingIdRef.current
            const chunk = (delta.thinking as string) ?? ''
            setItems((prev) =>
              prev.map((it) =>
                it.kind === 'thinking' && it.id === tid ? { ...it, text: it.text + chunk } : it
              )
            )
          }
        } else if (evType === 'content_block_stop') {
          // A thinking block ended — stop appending to it.
          thinkingIdRef.current = null
        }
        return
      }

      if (type === 'assistant') {
        const msg = event.message as Record<string, unknown>
        const content = (msg?.content as Record<string, unknown>[]) || []
        for (const block of content) {
          if (block.type === 'tool_use') {
            setThinking(false)
            const name = block.name as string
            const id = block.id as string
            // TodoWrite carries Claude's live task list — surface it in the Tasks panel.
            if (name === 'TodoWrite') {
              const list = (block.input as { todos?: unknown })?.todos
              if (Array.isArray(list)) {
                useStore.getState().setTodos(workspaceId, list as TodoItem[])
              }
            }
            const diff = toolDiff(name, id, block.input)
            setItems((prev) => [
              ...prev,
              diff
                ? { kind: 'diff', diff }
                : { kind: 'tool', tool: { id, name, detail: toolDetail(block.input) } }
            ])
          }
        }
        // Finalize the streaming text message.
        const sid = streamingIdRef.current
        if (sid) {
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'msg' && it.msg.id === sid
                ? { ...it, msg: { ...it.msg, streaming: false } }
                : it
            )
          )
        }
        return
      }

      if (type === 'result') {
        // A completed turn means the session genuinely works — clear the guard so
        // a future crash gets a resume-retry before falling back to fresh.
        resumeRetriedRef.current = false
        streamingIdRef.current = null
        setElapsed(0)
        // First turn is done: let the agent name the conversation, replacing the
        // opening-message placeholder. Skipped if the user already renamed it.
        if (!aiTitledRef.current) {
          aiTitledRef.current = true
          void nameConversation()
        }
        // Send the next stacked message, if any; otherwise the turn is done.
        const next = queueRef.current.shift()
        const id = agentIdRef.current
        if (next && id) {
          window.cove.agentSend(
            id,
            next.text,
            next.images.map((im) => ({ mediaType: im.mediaType, data: im.data }))
          )
          setThinking(true) // stay generating for the next queued turn
        } else {
          setThinking(false)
          setGenerating(false)
        }
      }
    },
    [workspaceId, chatId, nameConversation]
  )

  // The agent's lifecycle must not be tied to this callback's identity: the effect
  // below stops the claude process on teardown, so a re-created handleEvent (which
  // is what Fast Refresh hands us on every edit) would kill a generation mid-turn.
  const handleEventRef = useRef(handleEvent)
  useEffect(() => {
    handleEventRef.current = handleEvent
  }, [handleEvent])

  useEffect(() => {
    let disposed = false
    let offEvent: (() => void) | undefined
    let offExit: (() => void) | undefined

    window.cove
      .agentStart({
        cwd,
        workspaceId,
        resumeSessionId: resumeIdRef.current,
        browserProject,
        permissionMode: useStore.getState().permissionMode
      })
      .then((id) => {
        if (disposed) {
          window.cove.agentStop(id)
          return
        }
        agentIdRef.current = id
        registerAgent(workspaceId, id)
        // Ready as soon as the process is up — in stream-json input mode claude
        // waits for the first user message before it emits anything.
        setReady(true)
        offEvent = window.cove.onAgentEvent(id, (e) => handleEventRef.current(e))
        // main only emits agent:exit on a genuine unexpected exit (deliberate
        // stops and the resume→fresh retry are suppressed), so surface it.
        offExit = window.cove.onAgentExit(id, () => {
          setReady(false)
          setGenerating(false)
          setThinking(false)
          setAgentFailed(true)
        })
      })

    return () => {
      disposed = true
      offEvent?.()
      offExit?.()
      if (agentIdRef.current) window.cove.agentStop(agentIdRef.current)
    }
  }, [cwd, workspaceId, chatId, registerAgent, resetKey, browserProject])

  // Auto-scroll only when the user is already near the bottom, so scrolling up
  // to read scrollback isn't interrupted.
  useEffect(() => {
    if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items, thinking, atBottom])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAtBottom(near)
  }

  const scrollToBottom = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setAtBottom(true)
  }

  // Messages injected from toolbar actions (e.g. the Skills panel) in Easy mode.
  useEffect(() => {
    const onInjected = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { workspaceId: string; text: string }
      if (detail.workspaceId !== workspaceId) return
      setItems((prev) => [
        ...prev,
        { kind: 'msg', msg: { id: `u-${Date.now()}`, role: 'user', text: detail.text } }
      ])
      setThinking(true)
      setGenerating(true)
    }
    window.addEventListener('cove:easy-user-message', onInjected)
    return () => window.removeEventListener('cove:easy-user-message', onInjected)
  }, [workspaceId])

  const submit = (text: string, images: PendingImage[] = []): void => {
    const id = agentIdRef.current
    if ((!text && images.length === 0) || !id || !ready) return
    const reply = replyTarget
    setReplyTarget(null)
    // Name an untitled chat after its opening message, so the sidebar list is
    // scannable without the user having to name anything.
    if (text.trim() && items.length === 0) {
      // Provisional, so the sidebar isn't blank while the turn runs; the agent
      // replaces it with a real summary once it has something to summarize.
      const title = text.trim().replace(/\s+/g, ' ').slice(0, 60)
      placeholderTitleRef.current = title
      aiTitledRef.current = false
      window.cove.chatUpdate(chatId, { title })
      useStore.getState().touchChat(workspaceId, chatId, { title })
    }
    // Show the message and clear the composer right away.
    setItems((prev) => [
      ...prev,
      {
        kind: 'msg',
        msg: {
          id: `u-${Date.now()}-${Math.random()}`,
          role: 'user',
          text,
          images: images.length ? images.map((im) => im.url) : undefined,
          replyTo: reply ?? undefined
        }
      }
    ])
    setInput('')
    setPendingImages([])
    if (inputRef.current) inputRef.current.style.height = 'auto'
    // Quote the replied-to message so the agent knows what you're responding to.
    const agentText = reply
      ? `> Replying to ${reply.role === 'user' ? 'my' : 'your'} earlier message:\n> "${reply.text.replace(/\s+/g, ' ').trim().slice(0, 400)}"\n\n${text}`
      : text
    // Mid-turn: stack it — it's sent when the current turn finishes.
    if (generating) {
      queueRef.current.push({ text: agentText, images })
      return
    }
    window.cove.agentSend(
      id,
      agentText,
      images.map((im) => ({ mediaType: im.mediaType, data: im.data }))
    )
    setThinking(true)
    setGenerating(true)
  }

  const send = (): void => submit(input.trim(), pendingImages)

  const beginReply = (msg: ChatMessage): void => {
    setReplyTarget({ role: msg.role, text: msg.text })
    inputRef.current?.focus()
  }

  // Edit your last message (e.g. after Stop): put it back in the composer and drop
  // it — and anything after it — from the transcript, so you can fix it and resend.
  const editMessage = (msg: ChatMessage): void => {
    setInput(msg.text)
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.kind === 'msg' && it.msg.id === msg.id)
      return idx >= 0 ? prev.slice(0, idx) : prev
    })
    requestAnimationFrame(() => {
      autoResize()
      inputRef.current?.focus()
    })
  }

  // The most recent user message — it gets an Edit affordance when idle.
  let lastUserId: string | null = null
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]
    if (it.kind === 'msg' && it.msg.role === 'user') {
      lastUserId = it.msg.id
      break
    }
  }
  // Swipe a message to the right to reply to it (like WhatsApp).
  const onMsgPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    swipeRef.current = { x: e.clientX, y: e.clientY, el: e.currentTarget }
  }
  const onMsgPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = swipeRef.current
    if (!s) return
    const dx = e.clientX - s.x
    // Only engage on a clear rightward drag, so text selection/scroll still work.
    if (dx > 8 && Math.abs(dx) > Math.abs(e.clientY - s.y)) {
      s.el.setPointerCapture?.(e.pointerId)
      s.el.style.transition = 'none'
      s.el.style.transform = `translateX(${Math.min(dx, 72)}px)`
    }
  }
  const onMsgPointerUp = (e: React.PointerEvent<HTMLDivElement>, msg: ChatMessage): void => {
    const s = swipeRef.current
    if (!s) return
    const dx = e.clientX - s.x
    s.el.style.transition = ''
    s.el.style.transform = ''
    swipeRef.current = null
    if (dx > 48) beginReply(msg)
  }

  const stop = (): void => {
    queueRef.current = [] // Stop means stop — drop anything stacked.
    const id = agentIdRef.current
    if (id) window.cove.agentInterrupt(id)
    setThinking(false)
    setGenerating(false)
    setElapsed(0)
  }

  const startDictation = useCallback((): void => {
    if (dictation.state !== 'idle') return
    void dictation.start()
  }, [dictation])

  // Insert at the caret rather than appending, so you can dictate into the
  // middle of something you already typed.
  const finishDictation = useCallback((): void => {
    if (dictation.state !== 'recording') return
    void dictation.stop().then((text) => {
      if (!text) return
      const el = inputRef.current
      const at = el ? (el.selectionStart ?? el.value.length) : input.length
      setInput((prev) => {
        const before = prev.slice(0, at)
        const after = prev.slice(at)
        const spacer = before && !/\s$/.test(before) ? ' ' : ''
        return before + spacer + text + after
      })
      el?.focus()
    })
  }, [dictation, input.length])

  // Hold ⌥Space to dictate from anywhere in the window; release to transcribe.
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.altKey && e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        startDictation()
      }
    }
    const up = (e: KeyboardEvent): void => {
      // Releasing either key ends the gesture — holding ⌥ and letting go of
      // Space (or vice versa) should both stop, not leave the mic open.
      if (e.code === 'Space' || e.key === 'Alt') finishDictation()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [startDictation, finishDictation])

  // Adds a sibling conversation rather than wiping this one — the previous chat
  // keeps its transcript and stays resumable from the sidebar.
  const newChat = (): void => {
    setInput('')
    setPendingImages([])
    setMentionQuery(null)
    setElapsed(0)
    queueRef.current = []
    useStore.getState().clearTodos(workspaceId)
    useStore.getState().newChat(workspaceId)
  }

  // Restart the agent after an unexpected exit — keeps the conversation. Resumes
  // the session, but if a resume-retry already failed, start fresh so a stale
  // session lock can't loop the Retry button.
  const retry = (): void => {
    setAgentFailed(false)
    setReady(false)
    if (resumeRetriedRef.current && resumeIdRef.current) {
      resumeIdRef.current = null
      window.cove.chatUpdate(chatId, { claudeSessionId: null })
    }
    resumeRetriedRef.current = true
    setResetKey((k) => k + 1)
  }

  return (
    <div
      ref={chatRef}
      className={`easy-chat ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        // Allow the drop (default would block it); the window effect shows the hint.
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={onDrop}
    >
      {dragOver && <div className="easy-drop-hint">Drop a file to add it</div>}
      {items.length > 0 && (
        <button className="easy-newchat" onClick={newChat} title="Start a new conversation">
          ✎ New chat
        </button>
      )}
      {agentFailed && (
        <div className="easy-error">
          <span>
            ⚠ Claude stopped. Make sure Claude Code is installed and you&rsquo;re signed in.
          </span>
          <button onClick={retry}>Retry</button>
        </div>
      )}
      <TasksPanel workspaceId={workspaceId} />
      <div className="easy-scroll" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 && ready && (
          <div className="easy-empty">
            <p>Tell Claude what you&rsquo;d like to build or change.</p>
          </div>
        )}
        {items.length === 0 && !ready && !agentFailed && (
          <div className="easy-empty">Starting Claude…</div>
        )}
        {toRows(items).map((row, i) => {
          if (row.kind === 'msg') {
            const isAssistant = row.msg.role === 'assistant'
            const isLastUser = !isAssistant && row.msg.id === lastUserId
            return (
              <div
                key={row.msg.id + i}
                className={`easy-msg easy-${row.msg.role}`}
                onPointerDown={onMsgPointerDown}
                onPointerMove={onMsgPointerMove}
                onPointerUp={(e) => onMsgPointerUp(e, row.msg)}
              >
                {row.msg.replyTo && (
                  <div className="easy-reply-quote">
                    <span className="easy-reply-quote-who">
                      {row.msg.replyTo.role === 'user' ? 'You' : 'Claude'}
                    </span>
                    <span className="easy-reply-quote-text">
                      {row.msg.replyTo.text.replace(/\s+/g, ' ').trim().slice(0, 120)}
                    </span>
                  </div>
                )}
                {row.msg.images && row.msg.images.length > 0 && (
                  <div className="easy-msg-images">
                    {row.msg.images.map((src, ii) => (
                      <img key={ii} src={src} alt="attachment" />
                    ))}
                  </div>
                )}
                {isAssistant ? <Markdown text={row.msg.text} /> : row.msg.text}
                {row.msg.streaming && <span className="easy-caret" />}
                {!row.msg.streaming && row.msg.text && (
                  <button
                    className="easy-msg-reply"
                    title="Reply to this message"
                    onClick={() => beginReply(row.msg)}
                  >
                    ↩
                  </button>
                )}
                {isAssistant && !row.msg.streaming && row.msg.text && (
                  <button
                    className="easy-msg-copy"
                    title="Copy"
                    onClick={() => navigator.clipboard.writeText(row.msg.text)}
                  >
                    Copy
                  </button>
                )}
                {isLastUser && !generating && row.msg.text && (
                  <button
                    className="easy-msg-edit"
                    title="Edit & resend"
                    onClick={() => editMessage(row.msg)}
                  >
                    Edit
                  </button>
                )}
              </div>
            )
          }
          if (row.kind === 'thinking') {
            if (!row.text) return null
            return (
              <div key={row.id} className="easy-thought">
                {row.text}
              </div>
            )
          }
          return <ActivityStrip key={'act-' + i} entries={row.entries} />
        })}
        {generating && (
          <div className="easy-thinking">
            <span />
            <span />
            <span />
            {elapsed > 0 && <span className="easy-elapsed">Working {elapsed}s</span>}
          </div>
        )}
      </div>
      {!atBottom && items.length > 0 && (
        <button className="easy-scrolldown" onClick={scrollToBottom} title="Scroll to bottom">
          ↓
        </button>
      )}
      {dictation.error && (
        <div className="easy-dictation-error" role="status">
          Dictation failed: {dictation.error}
        </div>
      )}
      <div className="easy-input-row">
        {replyTarget && (
          <div className="easy-reply-bar">
            <span className="easy-reply-bar-icon">↩</span>
            <span className="easy-reply-bar-text">
              {replyTarget.text.replace(/\s+/g, ' ').trim().slice(0, 160)}
            </span>
            <button
              className="easy-reply-bar-cancel"
              title="Cancel reply"
              onClick={() => setReplyTarget(null)}
            >
              ×
            </button>
          </div>
        )}
        {mentionMatches.length > 0 && (
          <div className="easy-mention-menu">
            {mentionMatches.map((f, idx) => (
              <button
                key={f}
                className={`easy-mention-item ${idx === mentionIndex ? 'active' : ''}`}
                onMouseEnter={() => setMentionIndex(idx)}
                onClick={() => pickMention(f)}
              >
                {mentionKind === 'cmd' ? `/${f}` : f}
              </button>
            ))}
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="easy-attachments">
            {pendingImages.map((img, idx) => (
              <div key={idx} className="easy-attachment">
                <img src={img.url} alt="pasted" />
                <button
                  className="easy-attachment-remove"
                  onClick={() => setPendingImages((prev) => prev.filter((_, i) => i !== idx))}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="easy-input"
          value={input}
          placeholder={
            ready ? 'Message Claude…  (/ commands · @ files · paste an image)' : 'Starting…'
          }
          rows={1}
          disabled={!ready}
          onChange={(e) => {
            setInput(e.target.value)
            autoResize()
            updateMention(e.target.value)
          }}
          onKeyDown={(e) => {
            if (mentionMatches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMentionIndex((i) => (i + 1) % mentionMatches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pickMention(mentionMatches[mentionIndex])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMentionQuery(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          className={`easy-mic ${dictation.state === 'recording' ? 'recording' : ''}`}
          // Pointer, not click: dictation runs for exactly as long as you hold.
          onPointerDown={startDictation}
          onPointerUp={finishDictation}
          onPointerLeave={finishDictation}
          disabled={dictation.state === 'transcribing' || dictation.state === 'loading-model'}
          title={micTitle}
          aria-label={micTitle}
        >
          {dictation.state === 'loading-model' && dictation.progress > 0 ? (
            <span className="easy-mic-pct">{Math.round(dictation.progress)}</span>
          ) : (
            <MicIcon />
          )}
        </button>
        {generating ? (
          <button className="easy-stop" onClick={stop} title="Stop generating">
            <span className="easy-stop-square" />
          </button>
        ) : (
          <button
            className="easy-send"
            onClick={send}
            disabled={!ready || (!input.trim() && pendingImages.length === 0)}
            title="Send message"
            aria-label="Send message"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
