import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { HookConsent } from './components/HookConsent'
import { PreviewToast } from './components/PreviewToast'
import { Onboarding } from './components/Onboarding'
import { useStore } from './state'

function App(): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const startHookListener = useStore((s) => s.startHookListener)
  const startBrowsingListener = useStore((s) => s.startBrowsingListener)
  const active = tree.flatMap((g) => g.workspaces).find((w) => w.id === activeId)
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('cove.onboarded') === '1')

  useEffect(() => {
    startHookListener()
    startBrowsingListener()
  }, [startHookListener, startBrowsingListener])

  if (!onboarded) {
    return (
      <Onboarding
        onDone={() => {
          localStorage.setItem('cove.onboarded', '1')
          setOnboarded(true)
        }}
      />
    )
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        <div className="content-titlebar" />
        <HookConsent />
        {active ? (
          <WorkspaceView key={active.id} ws={active} />
        ) : (
          <div className="empty-state">
            <div className="empty-state-inner">
              <h1>Welcome to Cove</h1>
              <p>Add a project folder from the sidebar to start a Claude session.</p>
            </div>
          </div>
        )}
      </main>
      <PreviewToast />
    </div>
  )
}

export default App
