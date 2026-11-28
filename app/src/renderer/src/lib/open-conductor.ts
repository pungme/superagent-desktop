import { useStore } from '../state'

/**
 * Open a project's Conductor: its Main chat, which shows as the Conductor view. Used by the
 * sidebar's Conductor section and right after a Conductor is started.
 */
export async function openConductor(workspaceId: string): Promise<void> {
  const state = await window.cove.conductorGet(workspaceId)
  const st = useStore.getState()
  st.setActive(workspaceId)
  // Main's desk shows as the Conductor view by itself: Main on the left, the sessions on the right.
  if (state) st.selectChat(workspaceId, state.chatId)
}
