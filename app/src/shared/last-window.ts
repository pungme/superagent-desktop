/**
 * What the app does when its last window closes (the dot is not a window in
 * this sense). On macOS it stays, as apps do, unless an update has downloaded:
 * then this is the moment to install it, with nothing open to lose. With the
 * dot on, the user is relying on Superagent running without a window, so it
 * restarts into the update and the dot is back in a few seconds; a plain quit
 * (which is what it did) took the dot with it, and nothing brought it back.
 */
export function afterLastWindow(
  platform: NodeJS.Platform,
  updateDownloaded: boolean,
  dotOn: boolean
): 'stay' | 'quit' | 'restart' {
  if (platform !== 'darwin') return 'quit'
  if (!updateDownloaded) return 'stay'
  return dotOn ? 'restart' : 'quit'
}
