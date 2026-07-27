import { useEffect, useRef, useState, useCallback } from 'react'
import { useStore } from '../state'
import { Markdown } from './Markdown'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  images?: string[] // data URLs, for user messages
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

const SUGGESTIONS = [
  'Explain what this project does',
  'Find and fix a bug',
  'Add a small feature',
  'Check my site works'
]

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
    .map((n) => n.trim().replace(/^mcp__[a-z0-9-]+__/i, '').replace(/_/g, ' '))
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

// Group consecutive tool items so a run of tool calls renders as one compact strip.
type Row =
  | { kind: 'msg'; msg: ChatMessage }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'diff'; diff: FileDiff }
  | { kind: 'tools'; tools: ToolCall[] }

function toRows(items: Item[]): Row[] {
  const rows: Row[] = []
  for (const it of items) {
    if (it.kind === 'tool') {
      const last = rows[rows.length - 1]
      if (last && last.kind === 'tools') last.tools.push(it.tool)
      else rows.push({ kind: 'tools', tools: [it.tool] })
    } else {
      rows.push(it)
    }
  }
  return rows
}

export function EasyChat({
  cwd,
  workspaceId,
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
  const agentIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamingIdRef = useRef<string | null>(null)
  const thinkingIdRef = useRef<string | null>(null)
  // Session to resume so context survives restarts; updated once claude reports it.
  const resumeIdRef = useRef<string | null>(initialSessionId ?? null)
  // True once a resume-based retry has already failed, so the next retry drops the
  // resume and starts fresh (a crashed session can leave a stale lock that keeps
  // failing to resume, which would otherwise loop the Retry button).
  const resumeRetriedRef = useRef(false)
  const registerAgent = useStore((s) => s.registerAgent)

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
    window.cove.chatLoad(workspaceId).then((json) => {
      if (!alive) return
      if (json) {
        try {
          const saved = JSON.parse(json) as Item[]
          if (saved.length) setItems((prev) => (prev.length === 0 ? saved : prev))
        } catch {
          // Ignore a corrupt blob — start fresh.
        }
      }
      hydratedRef.current = true
    })
    return () => {
      alive = false
    }
  }, [workspaceId])

  useEffect(() => {
    if (!hydratedRef.current) return
    const t = setTimeout(() => {
      // Persist a clean copy — no mid-stream flags to reanimate on reload.
      const clean = items.map((it) =>
        it.kind === 'msg' && it.msg.streaming ? { ...it, msg: { ...it.msg, streaming: false } } : it
      )
      window.cove.chatSave(workspaceId, JSON.stringify(clean))
    }, 400)
    return () => clearTimeout(t)
  }, [items, workspaceId])

  // Paste a screenshot/image into the composer.
  const onPaste = (e: React.ClipboardEvent): void => {
    const imgItems = [...e.clipboardData.items].filter((it) => it.type.startsWith('image/'))
    if (imgItems.length === 0) return
    e.preventDefault()
    for (const item of imgItems) {
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = (): void => {
        const url = reader.result as string
        const data = url.split(',')[1] ?? ''
        setPendingImages((prev) => [...prev, { mediaType: file.type, data, url }])
      }
      reader.readAsDataURL(file)
    }
  }

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

  const handleEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = event.type as string

      if (type === 'system' && (event.subtype as string) === 'init') {
        setReady(true)
        // Remember the session id so we can resume this conversation next launch.
        const sid = event.session_id as string | undefined
        if (sid && sid !== resumeIdRef.current) {
          resumeIdRef.current = sid
          window.cove.updateWorkspace(workspaceId, { lastSessionId: sid })
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
    [workspaceId]
  )

  useEffect(() => {
    let disposed = false
    let offEvent: (() => void) | undefined
    let offExit: (() => void) | undefined

    window.cove
      .agentStart({ cwd, workspaceId, resumeSessionId: resumeIdRef.current, browserProject })
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
        offEvent = window.cove.onAgentEvent(id, handleEvent)
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
  }, [cwd, workspaceId, registerAgent, handleEvent, resetKey, browserProject])

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

  // Messages injected from toolbar actions (Skills, "Check my site") in Easy mode.
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
    // Show the message and clear the composer right away.
    setItems((prev) => [
      ...prev,
      {
        kind: 'msg',
        msg: {
          id: `u-${Date.now()}-${Math.random()}`,
          role: 'user',
          text,
          images: images.length ? images.map((im) => im.url) : undefined
        }
      }
    ])
    setInput('')
    setPendingImages([])
    if (inputRef.current) inputRef.current.style.height = 'auto'
    // Mid-turn: stack it — it's sent when the current turn finishes.
    if (generating) {
      queueRef.current.push({ text, images })
      return
    }
    window.cove.agentSend(
      id,
      text,
      images.map((im) => ({ mediaType: im.mediaType, data: im.data }))
    )
    setThinking(true)
    setGenerating(true)
  }

  const send = (): void => submit(input.trim(), pendingImages)

  const stop = (): void => {
    queueRef.current = [] // Stop means stop — drop anything stacked.
    const id = agentIdRef.current
    if (id) window.cove.agentInterrupt(id)
    setThinking(false)
    setGenerating(false)
    setElapsed(0)
  }

  const newChat = (): void => {
    setItems([])
    setInput('')
    setPendingImages([])
    setMentionQuery(null)
    setThinking(false)
    setGenerating(false)
    setElapsed(0)
    setReady(false)
    setAgentFailed(false)
    queueRef.current = []
    window.cove.chatClear(workspaceId)
    // Forget the resumed session so the next agent starts a brand-new one.
    resumeIdRef.current = null
    resumeRetriedRef.current = false
    window.cove.updateWorkspace(workspaceId, { lastSessionId: null })
    // Bumping resetKey tears down the current agent and starts a fresh session.
    setResetKey((k) => k + 1)
  }

  // Restart the agent after an unexpected exit — keeps the conversation (unlike
  // New chat). Resumes the session, but if a resume-retry already failed, start
  // fresh so a stale session lock can't loop the Retry button.
  const retry = (): void => {
    setAgentFailed(false)
    setReady(false)
    if (resumeRetriedRef.current && resumeIdRef.current) {
      resumeIdRef.current = null
      window.cove.updateWorkspace(workspaceId, { lastSessionId: null })
    }
    resumeRetriedRef.current = true
    setResetKey((k) => k + 1)
  }

  return (
    <div className="easy-chat">
      {items.length > 0 && (
        <button className="easy-newchat" onClick={newChat} title="Start a new conversation">
          ✎ New chat
        </button>
      )}
      {agentFailed && (
        <div className="easy-error">
          <span>⚠ Claude stopped. Make sure Claude Code is installed and you&rsquo;re signed in.</span>
          <button onClick={retry}>Retry</button>
        </div>
      )}
      <div className="easy-scroll" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 && ready && (
          <div className="easy-empty">
            <p>Tell Claude what you&rsquo;d like to build or change.</p>
            <div className="easy-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="easy-suggestion" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.length === 0 && !ready && !agentFailed && (
          <div className="easy-empty">Starting Claude…</div>
        )}
        {toRows(items).map((row, i) => {
          if (row.kind === 'msg') {
            const isAssistant = row.msg.role === 'assistant'
            return (
              <div key={row.msg.id + i} className={`easy-msg easy-${row.msg.role}`}>
                {row.msg.images && row.msg.images.length > 0 && (
                  <div className="easy-msg-images">
                    {row.msg.images.map((src, ii) => (
                      <img key={ii} src={src} alt="attachment" />
                    ))}
                  </div>
                )}
                {isAssistant ? <Markdown text={row.msg.text} /> : row.msg.text}
                {row.msg.streaming && <span className="easy-caret" />}
                {isAssistant && !row.msg.streaming && row.msg.text && (
                  <button
                    className="easy-msg-copy"
                    title="Copy"
                    onClick={() => navigator.clipboard.writeText(row.msg.text)}
                  >
                    Copy
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
          if (row.kind === 'diff') {
            const d = row.diff
            const added = d.hunks.reduce((n, h) => n + h.added.length, 0)
            const removed = d.hunks.reduce((n, h) => n + h.removed.length, 0)
            return (
              <div key={d.id} className="easy-diff">
                <div className="easy-diff-head">
                  <span className="easy-diff-file">✏️ {d.file}</span>
                  <span className="easy-diff-stat">
                    {added > 0 && <span className="easy-diff-plus">+{added}</span>}
                    {removed > 0 && <span className="easy-diff-minus">−{removed}</span>}
                  </span>
                </div>
                <pre className="easy-diff-body">
                  {d.hunks.map((h, hi) => (
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
              </div>
            )
          }
          return (
            <div key={'tools-' + i} className="easy-tools">
              {row.tools.map((t, j) => {
                const { icon, verb } = toolLabel(t.name)
                return (
                  <span key={t.id + j} className="easy-tool" title={t.detail}>
                    <span className="easy-tool-icon">{icon}</span>
                    <span className="easy-tool-verb">{verb}</span>
                    {t.detail && <span className="easy-tool-detail">{t.detail}</span>}
                  </span>
                )
              })}
            </div>
          )
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
      <div className="easy-input-row">
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
          onPaste={onPaste}
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
