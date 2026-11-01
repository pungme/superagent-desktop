import { describe, expect, it, vi } from 'vitest'

const made: { opts: Record<string, unknown>; destroyed: boolean; visible: boolean }[] = []
vi.mock('electron', () => {
  class BrowserWindow {
    rec: { opts: Record<string, unknown>; destroyed: boolean; visible: boolean }
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    constructor(opts: Record<string, unknown>) {
      this.rec = { opts, destroyed: false, visible: false }
      made.push(this.rec)
    }
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
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
    app: { isPackaged: false, focus: vi.fn() },
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
})
