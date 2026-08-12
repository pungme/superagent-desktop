/** An entry on the desk: a file or folder, possibly a link to somewhere else. */
export interface DeskEntry {
  name: string
  path: string
  target: string
  dir: boolean
  link: boolean
}

/**
 * Fired whenever the desk changes, so every window showing part of it — the
 * desk surface and any open folder window — redraws. Kept out of the component
 * files so those can hot-reload.
 */
export function announceDeskChange(): void {
  window.dispatchEvent(new CustomEvent('cove:desk-changed'))
}
