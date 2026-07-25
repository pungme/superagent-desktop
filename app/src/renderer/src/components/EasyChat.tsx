import { useEffect, useRef, useState, useCallback } from 'react'
import { useStore } from '../state'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
}

interface ToolCall {
  id: string
  name: string
  input: string
}

type Item = { kind: 'msg'; msg: ChatMessage } | { kind: 'tool'; tool: ToolCall }

interface EasyChatProps {
  cwd: string
  workspaceId: string
}

// Friendly labels for the noisy internal tool names.
function toolLabel(name: string): string {
  if (name.startsWith('mcp__cove-browser__browser_'))
    return '🌐 ' + name.replace('mcp__cove-browser__browser_', '').replace(/_/g, ' ')
  const map: Record<string, string> = {
    Bash: '⌘ Running a command',
    Read: '📄 Reading a file',
    Edit: '✏️ Editing a file',
    Write: '✏️ Writing a file',
    Glob: '🔎 Finding files',
    Grep: '🔎 Searching',
    WebFetch: '🌐 Fetching a page',
    WebSearch: '🔎 Searching the web',
    TodoWrite: '✓ Updating the plan',
    Task: '🤖 Running a sub-agent'
  }
  return map[name] || `🔧 ${name}`
}

export function EasyChat({ cwd, workspaceId }: EasyChatProps): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [ready, setReady] = useState(false)
  const agentIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const streamingIdRef = useRef<string | null>(null)
  const registerAgent = useStore((s) => s.registerAgent)

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
        }
      }
      return
    }

    if (type === 'assistant') {
      const msg = event.message as Record<string, unknown>
      const content = (msg?.content as Record<string, unknown>[]) || []
      for (const block of content) {
        if (block.type === 'tool_use') {
          setThinking(false)
          setItems((prev) => [
            ...prev,
            {
              kind: 'tool',
              tool: {
                id: block.id as string,
                name: block.name as string,
                input: JSON.stringify(block.input)
              }
            }
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
  }, [cwd, workspaceId, registerAgent, handleEvent])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items, thinking])

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
    }
    window.addEventListener('cove:easy-user-message', onInjected)
    return () => window.removeEventListener('cove:easy-user-message', onInjected)
  }, [workspaceId])

  const send = (): void => {
    const text = input.trim()
    const id = agentIdRef.current
    if (!text || !id || !ready) return
    setItems((prev) => [
      ...prev,
      { kind: 'msg', msg: { id: `u-${Date.now()}`, role: 'user', text } }
    ])
    window.cove.agentSend(id, text)
    setInput('')
    setThinking(true)
  }

  return (
    <div className="easy-chat">
      <div className="easy-scroll" ref={scrollRef}>
        {items.length === 0 && ready && (
          <div className="easy-empty">
            <p>Tell Claude what you&rsquo;d like to build or change.</p>
          </div>
        )}
        {items.length === 0 && !ready && <div className="easy-empty">Starting Claude…</div>}
        {items.map((it, i) =>
          it.kind === 'msg' ? (
            <div key={it.msg.id + i} className={`easy-msg easy-${it.msg.role}`}>
              {it.msg.text}
              {it.msg.streaming && <span className="easy-caret" />}
            </div>
          ) : (
            <div key={it.tool.id + i} className="easy-tool">
              <span className="easy-tool-label">{toolLabel(it.tool.name)}</span>
            </div>
          )
        )}
        {thinking && (
          <div className="easy-thinking">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      <div className="easy-input-row">
        <textarea
          className="easy-input"
          value={input}
          placeholder={ready ? 'Message Claude…' : 'Starting…'}
          rows={1}
          disabled={!ready}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="easy-send" onClick={send} disabled={!ready || !input.trim()}>
          ↑
        </button>
      </div>
    </div>
  )
}
