import { describe, it, expect, vi } from 'vitest'

/**
 * The one line where being backwards would be silent and awful.
 *
 * A native pane is placed in the WINDOW's pixels; the renderer measures its
 * slot in CSS pixels. Zoomed in, a CSS pixel covers more than one window pixel,
 * so the window number is the larger one — multiply. Divide instead and the
 * page lands further from its pane than it did before the "fix".
 */
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { on: () => undefined, removeListener: () => undefined },
  ipcMain: { on: () => undefined, handle: () => undefined },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0', isPackaged: false },
  session: { fromPartition: () => ({ setPermissionRequestHandler: () => undefined }) },
  shell: {},
  clipboard: {},
  nativeImage: { createFromBuffer: () => ({}) },
  WebContentsView: class {}
}))
vi.mock('./util', () => ({ broadcastToWindows: () => undefined }))
vi.mock('./store', () => ({ kvGet: () => undefined, kvSet: () => undefined }))
vi.mock('./mcp', () => ({ getMcpUrl: () => '' }))

const { scaleToWindowPixels } = await import('./browser')

describe('a pane at a window zoom', () => {
  const slot = { x: 100, y: 100, width: 800, height: 600 }

  it('is left alone at 100%', () => {
    expect(scaleToWindowPixels(slot, 1)).toEqual(slot)
  })

  /** Zoomed IN, the slot is further from the origin and bigger, not nearer. */
  it('moves away from the origin when zoomed in', () => {
    expect(scaleToWindowPixels(slot, 1.25)).toEqual({ x: 125, y: 125, width: 1000, height: 750 })
  })

  it('moves toward the origin when zoomed out', () => {
    expect(scaleToWindowPixels(slot, 0.8)).toEqual({ x: 80, y: 80, width: 640, height: 480 })
  })

  /** A zoom factor of 0 from a window mid-teardown must not collapse the pane. */
  it('treats a missing zoom as 100%', () => {
    expect(scaleToWindowPixels(slot, 0)).toEqual(slot)
  })
})
