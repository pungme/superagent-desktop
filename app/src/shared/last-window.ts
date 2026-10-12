/**
 * What the app does when its last window closes (the dot is not a window in
 * this sense). On macOS it stays, as apps do. A downloaded update does not
 * change that: closing the window can happen while agents are active, and a
 * silent quit/restart would kill them without the warning shown by the update
 * UI. Updates install through an explicit restart or Quit instead.
 */
export function afterLastWindow(
  platform: NodeJS.Platform,
  updateDownloaded: boolean,
  dotOn: boolean
): 'stay' | 'quit' | 'restart' {
  if (platform !== 'darwin') return 'quit'
  void updateDownloaded
  void dotOn
  return 'stay'
}
