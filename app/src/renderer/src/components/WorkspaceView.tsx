import { useStore } from '../state'
import { TerminalPane } from './TerminalPane'
import { BrowserPane } from './BrowserPane'
import type { Workspace } from '../../../preload'

export function WorkspaceView({ ws }: { ws: Workspace }): React.JSX.Element {
  const browserOpen = useStore((s) => s.browserOpen[ws.id] ?? false)
  const toggleBrowser = useStore((s) => s.toggleBrowser)
  const addPort = useStore((s) => s.addPort)

  return (
    <div className="workspace-view">
      <div className="workspace-toolbar">
        <span className="workspace-title">{ws.name}</span>
        <span className="workspace-path">{ws.path}</span>
        <div className="workspace-toolbar-spacer" />
        <button
          className={`toolbar-btn ${browserOpen ? 'on' : ''}`}
          onClick={() => toggleBrowser(ws.id)}
        >
          {browserOpen ? 'Hide preview' : 'Show preview'}
        </button>
      </div>
      <div className="content-split">
        <TerminalPane
          key={ws.id}
          cwd={ws.path}
          command="claude"
          workspaceId={ws.id}
          onPort={(port) => addPort(ws.id, port)}
        />
        {browserOpen && (
          <BrowserPane
            key={`${ws.id}-browser`}
            paneId={ws.id}
            partition={`persist:ws-${ws.id}`}
            initialUrl={ws.browserUrl ?? undefined}
          />
        )}
      </div>
    </div>
  )
}
