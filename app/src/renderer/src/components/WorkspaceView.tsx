import { useRef, useState, useCallback } from 'react'
import { useStore } from '../state'
import { TerminalPane } from './TerminalPane'
import { BrowserPane } from './BrowserPane'
import { EasyChat } from './EasyChat'
import { SkillsPanel } from './SkillsPanel'
import { RoutinesPanel } from './RoutinesPanel'
import type { Workspace } from '../../../preload'

export function WorkspaceView({ ws }: { ws: Workspace }): React.JSX.Element {
  const browserOpen = useStore((s) => s.browserOpen[ws.id] ?? false)
  const toggleBrowser = useStore((s) => s.toggleBrowser)
  const addPort = useStore((s) => s.addPort)
  const sendToClaude = useStore((s) => s.sendToClaude)
  const ports = useStore((s) => s.ports[ws.id])
  const easyMode = useStore((s) => s.easyMode)
  const setEasyMode = useStore((s) => s.setEasyMode)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [routinesOpen, setRoutinesOpen] = useState(false)

  const checkMySite = (): void => {
    const port = ports?.[ports.length - 1]
    const where = port ? `the preview at localhost:${port}` : 'my site in the browser'
    if (!browserOpen) toggleBrowser(ws.id)
    sendToClaude(
      ws.id,
      `Open ${where} using the cove-browser tools, click through the main flows, and report anything broken — include a screenshot of any problems.`
    )
  }

  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => {
    const saved = localStorage.getItem(`split:${ws.id}`)
    return saved ? Math.min(0.8, Math.max(0.2, Number(saved))) : 0.55
  })
  const [dragging, setDragging] = useState(false)

  const onDividerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      setDragging(true)
      const container = containerRef.current
      if (!container) return
      const move = (ev: PointerEvent): void => {
        const rect = container.getBoundingClientRect()
        setRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width)))
      }
      const up = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setRatio((r) => {
          localStorage.setItem(`split:${ws.id}`, String(r))
          return r
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [ws.id]
  )

  return (
    <div className="workspace-view">
      <div className="workspace-toolbar">
        <span className="workspace-title">{ws.name}</span>
        <span className="workspace-path">{ws.path}</span>
        <div className="mode-switch" role="tablist">
          <button
            className={`mode-switch-btn ${easyMode ? 'active' : ''}`}
            onClick={() => setEasyMode(true)}
          >
            Easy
          </button>
          <button
            className={`mode-switch-btn ${!easyMode ? 'active' : ''}`}
            onClick={() => setEasyMode(false)}
          >
            Terminal
          </button>
        </div>
        <div className="workspace-toolbar-spacer" />
        <button className="toolbar-btn" onClick={() => setRoutinesOpen(true)} title="Scheduled tasks">
          ⏱ Routines
        </button>
        <button className="toolbar-btn" onClick={() => setSkillsOpen(true)} title="Your skills">
          ✦ Skills
        </button>
        <button className="toolbar-btn" onClick={checkMySite} title="Ask Claude to test your site">
          🔍 Check my site
        </button>
        <button
          className={`toolbar-btn ${browserOpen ? 'on' : ''}`}
          onClick={() => toggleBrowser(ws.id)}
        >
          {browserOpen ? 'Hide preview' : 'Show preview'}
        </button>
      </div>
      {/* Terminal stays mounted (stable position) whether or not the browser is open,
          so toggling the preview never kills the Claude session. */}
      <div ref={containerRef} className="content-split">
        <div
          className="split-side"
          style={{ flexBasis: browserOpen ? `${ratio * 100}%` : '100%' }}
        >
          {easyMode ? (
            <EasyChat cwd={ws.path} workspaceId={ws.id} />
          ) : (
            <TerminalPane
              cwd={ws.path}
              command="claude"
              workspaceId={ws.id}
              onPort={(port) => addPort(ws.id, port)}
            />
          )}
        </div>
        {browserOpen && (
          <>
            <div
              className={`split-divider ${dragging ? 'dragging' : ''}`}
              onPointerDown={onDividerDown}
              role="separator"
            />
            <div className="split-side" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
              <BrowserPane
                paneId={ws.id}
                partition={`persist:ws-${ws.id}`}
                initialUrl={ws.browserUrl ?? undefined}
              />
            </div>
          </>
        )}
      </div>
      {skillsOpen && (
        <SkillsPanel
          workspaceId={ws.id}
          projectPath={ws.path}
          onClose={() => setSkillsOpen(false)}
        />
      )}
      {routinesOpen && <RoutinesPanel ws={ws} onClose={() => setRoutinesOpen(false)} />}
    </div>
  )
}
