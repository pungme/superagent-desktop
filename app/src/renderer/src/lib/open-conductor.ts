import { useStore } from '../state'

/**
 * Open a project's Conductor: its Main chat in the desk and the Sessions tab beside it. Used by the
 * sidebar's Conductor section and right after a Conductor is started.
 */
export async function openConductor(workspaceId: string): Promise<void> {
  const state = await window.cove.conductorGet(workspaceId)
  const st = useStore.getState()
  st.setActive(workspaceId)
  if (state) st.selectChat(workspaceId, state.chatId)
  window.setTimeout(
    () => window.dispatchEvent(new CustomEvent('cove:app-pane', { detail: { pane: 'sessions' } })),
    150
  )
}
