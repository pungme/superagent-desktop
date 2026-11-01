import { describe, expect, it, vi } from 'vitest'

const dockShow = vi.hoisted(() => vi.fn(async () => undefined))

const made: {
  opts: Record<string, unknown>
  destroyed: boolean
  visible: boolean
  workspaces: unknown[][]
}[] = []
vi.mock('electron', () => {
  class BrowserWindow {
    rec: (typeof made)[number]
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    constructor(opts: Record<string, unknown>) {
      this.rec = { opts, destroyed: false, visible: false, workspaces: [] }
      made.push(this.rec)
    }
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = (...a: unknown[]): void => {
      this.rec.workspaces.push(a)
    }
    loadURL = vi.fn(async () => undefined)
    showInactive(): void {
      this.rec.visible = true
    }
    isVisible(): boolean {
      return this.rec.visible
    }
    isDestroyed(): boolean {
      return this.rec.destroyed
    }
    destroy(): void {
      this.rec.destroyed = true
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return {
        x: this.rec.opts.x as number,
        y: this.rec.opts.y as number,
        width: 440,
        height: 40
      }
    }
  }
  return {
    BrowserWindow,
    app: { isPackaged: false, focus: vi.fn(), dock: { show: dockShow } },
    dialog: {},
    screen: {
      getAllDisplays: () => [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
          workArea: { x: 0, y: 38, width: 1440, height: 862 }
        },
        {
          id: 2,
          bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
          workArea: { x: 1440, y: 0, width: 1920, height: 1080 }
        }
      ]
    }
  }
})

const { createBanner } = await import('./banner')
const d1 = { id: 1, name: 'A', bounds: { x: 0, y: 0, width: 1440, height: 900 } }
const d2 = { id: 2, name: 'B', bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }

describe('the banner', () => {
  it('is on every display, below the menu bar and the notch, and all of them have to be there', () => {
    made.length = 0
    const b = createBanner(() => undefined)
    expect(b.show({ deviceName: 'iPhone', display: d1, displays: [d1, d2] })).toBe(true)
    expect(made).toHaveLength(2)
    expect(b.bounds()).toHaveLength(2)
    // Under the 38-point menu bar of the first display; at the top of the second, which has none.
    expect(b.bounds()[0].y).toBeGreaterThanOrEqual(38)
    expect(b.bounds()[1].y).toBeLessThan(38)
    expect(b.bounds()[1].x).toBeGreaterThanOrEqual(1440)
    expect(b.ok()).toBe(true)
    // One lost, the banner is lost.
    made[1].destroyed = true
    expect(b.ok()).toBe(false)
    b.hide()
    expect(b.bounds()).toEqual([])
    expect(made[0].destroyed).toBe(true)
  })
  it('never takes the keyboard or the front', () => {
    made.length = 0
    createBanner(() => undefined).show({ deviceName: 'x', display: d1, displays: [d1] })
    expect(made[0].opts).toMatchObject({ focusable: false, type: 'panel', closable: false })
  })
  it('is over every space and full-screen app, the way that works: the process is transformed, so no skipTransformProcessType', () => {
    made.length = 0
    createBanner(() => undefined).show({ deviceName: 'x', display: d1, displays: [d1] })
    expect(made[0].workspaces).toEqual([[true, { visibleOnFullScreen: true }]])
  })

  it('brings the Dock icon back when the banner goes (measured: it stays hidden after the window is destroyed)', () => {
    made.length = 0
    dockShow.mockClear()
    const b = createBanner(() => undefined)
    b.show({ deviceName: 'x', display: d1, displays: [d1] })
    expect(dockShow).not.toHaveBeenCalled()
    b.hide()
    expect(dockShow).toHaveBeenCalledOnce()
    // Nothing shown, nothing to give back.
    b.hide()
    expect(dockShow).toHaveBeenCalledOnce()
  })

  it('in a quiet test run leaves the Dock as quiet.ts set it (hidden)', () => {
    made.length = 0
    dockShow.mockClear()
    process.env.COVE_E2E_QUIET = '1'
    try {
      const b = createBanner(() => undefined)
      b.show({ deviceName: 'x', display: d1, displays: [d1] })
      b.hide()
      expect(dockShow).not.toHaveBeenCalled()
    } finally {
      delete process.env.COVE_E2E_QUIET
    }
  })

  it('puts the app back the way it is told to (the dot floating again, when there is one)', () => {
    made.length = 0
    dockShow.mockClear()
    const restore = vi.fn()
    const b = createBanner(() => undefined, restore)
    b.show({ deviceName: 'x', display: d1, displays: [d1] })
    b.hide()
    expect(restore).toHaveBeenCalledOnce()
    expect(dockShow).not.toHaveBeenCalled()
  })
})
