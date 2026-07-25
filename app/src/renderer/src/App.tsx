import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { HookConsent } from './components/HookConsent'
import { PreviewToast } from './components/PreviewToast'
import { Onboarding } from './components/Onboarding'
import { Settings } from './components/Settings'
import { useStore } from './state'

function App(): React.JSX.Element {
  const tree = useStore((s) => s.tree)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const startHookListener = useStore((s) => s.startHookListener)
  const startBrowsingListener = useStore((s) => s.startBrowsingListener)
  const active = tree.flatMap((g) => g.workspaces).find((w) => w.id === activeId)
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('cove.onboarded') === '1')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const addGroup = useStore((s) => s.addGroup)
  const addWorkspace = useStore((s) => s.addWorkspace)

  const applyTheme = useStore((s) => s.applyTheme)

  useEffect(() => {
    startHookListener()
    startBrowsingListener()
    applyTheme()
    // Re-apply when the OS light/dark preference changes (matters for "System").
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [startHookListener, startBrowsingListener, applyTheme])

  useEffect(() => {
    const openSettings = (): void => setSettingsOpen(true)
    window.addEventListener('cove:open-settings', openSettings)
    return () => window.removeEventListener('cove:open-settings', openSettings)
  }, [])

  useEffect(() => {
    return window.cove.onMenu((action) => {
      if (action === 'settings') setSettingsOpen(true)
      else if (action === 'new-group') addGroup()
      else if (action === 'new-project') {
        const firstGroup = useStore.getState().tree[0]
        if (firstGroup) addWorkspace(firstGroup.id)
      } else {
        // skills / routines / toggle-preview are workspace-scoped; forward via window event
        window.dispatchEvent(new CustomEvent(`cove:menu-${action}`))
      }
    })
  }, [addGroup, addWorkspace])

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
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

export default App
