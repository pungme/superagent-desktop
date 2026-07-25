import { useEffect, useRef, useState, useCallback } from 'react'
import { useStore } from '../state'
import { Markdown } from './Markdown'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
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
  const lines = (s: unknown): string[] => (typeof s === 'string' && s ? s.split('\n') : [])
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
function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = o.query ?? o.url ?? o.pattern ?? o.command ?? o.prompt ?? o.description ?? o.text
  if (typeof pick === 'string') return pick.replace(/\s+/g, ' ').trim().slice(0, 70)
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

export function EasyChat({ cwd, workspaceId }: EasyChatProps): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [ready, setReady] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [resetKey, setResetKey] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [atBottom, setAtBottom] = useState(true)
  const agentIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamingIdRef = useRef<string | null>(null)
  const thinkingIdRef = useRef<string | null>(null)
  const registerAgent = useStore((s) => s.registerAgent)

  // Elapsed "Working Ns" timer while a turn is running. (Reset happens in the
  // event handlers that clear `generating`, so no synchronous setState here.)
  useEffect(() => {
    if (!generating) return
    const start = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500)
    return () => clearInterval(t)
  }, [generating])

  // Load the project's files once for @-mention autocomplete.
  useEffect(() => {
    window.cove.filesList(cwd).then(setFiles)
  }, [cwd])

  // Grow the input with its content, up to the CSS max-height.
  const autoResize = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  // Detect a "@query" being typed at the caret, for the file dropdown.
  const updateMention = (value: string): void => {
    const el = inputRef.current
    const caret = el ? el.selectionStart : value.length
    const before = value.slice(0, caret)
    const m = /(^|\s)@([\w./-]*)$/.exec(before)
    setMentionQuery(m ? m[2] : null)
    setMentionIndex(0)
  }

  const mentionMatches =
    mentionQuery === null
      ? []
      : (mentionQuery === ''
          ? files
          : files.filter((f) => f.toLowerCase().includes(mentionQuery.toLowerCase()))
        ).slice(0, 8)

  const pickMention = (path: string): void => {
    // Replace the trailing "@query" with "@path ".
    setInput((prev) => prev.replace(/@[\w./-]*$/, `@${path} `))
    setMentionQuery(null)
    inputRef.current?.focus()
  }

  const handleEvent = useCallback((event: Record<string, unknown>) => {
    const type = event.type as string

    if (type === 'system' && (event.subtype as string) === 'init') {
      setReady(true)
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
      setThinking(false)
      setGenerating(false)
      setElapsed(0)
      streamingIdRef.current = null
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let offEvent: (() => void) | undefined
    let offExit: (() => void) | undefined

    window.cove.agentStart({ cwd, workspaceId }).then((id) => {
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
      offExit = window.cove.onAgentExit(id, () => setReady(false))
    })

    return () => {
      disposed = true
      offEvent?.()
      offExit?.()
      if (agentIdRef.current) window.cove.agentStop(agentIdRef.current)
    }
  }, [cwd, workspaceId, registerAgent, handleEvent, resetKey])

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

  const submit = (text: string): void => {
    const id = agentIdRef.current
    if (!text || !id || !ready) return
    setItems((prev) => [
      ...prev,
      { kind: 'msg', msg: { id: `u-${Date.now()}`, role: 'user', text } }
    ])
    window.cove.agentSend(id, text)
    setInput('')
    setThinking(true)
    setGenerating(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }

  const send = (): void => submit(input.trim())

  const stop = (): void => {
    const id = agentIdRef.current
    if (id) window.cove.agentInterrupt(id)
    setThinking(false)
    setGenerating(false)
    setElapsed(0)
  }

  const newChat = (): void => {
    setItems([])
    setInput('')
    setThinking(false)
    setGenerating(false)
    setElapsed(0)
    setReady(false)
    // Bumping resetKey tears down the current agent and starts a fresh session.
    setResetKey((k) => k + 1)
  }

  return (
    <div className="easy-chat">
      {items.length > 0 && (
        <button className="easy-newchat" onClick={newChat} title="Start a new conversation">
          ✎ New chat
        </button>
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
        {items.length === 0 && !ready && <div className="easy-empty">Starting Claude…</div>}
        {toRows(items).map((row, i) => {
          if (row.kind === 'msg') {
            const isAssistant = row.msg.role === 'assistant'
            return (
              <div key={row.msg.id + i} className={`easy-msg easy-${row.msg.role}`}>
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
                {f}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="easy-input"
          value={input}
          placeholder={ready ? 'Message Claude…  (@ to add a file)' : 'Starting…'}
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
        {generating ? (
          <button className="easy-stop" onClick={stop} title="Stop generating">
            <span className="easy-stop-square" />
          </button>
        ) : (
          <button className="easy-send" onClick={send} disabled={!ready || !input.trim()}>
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
