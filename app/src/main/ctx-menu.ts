import { BrowserWindow, ipcMain, screen, type MenuItemConstructorOptions } from 'electron'

/**
 * Right-click menus drawn by the app instead of by macOS. Main still decides what is in a menu and
 * what each item does (the dialogs, the git calls, the Finder hand-offs are all here); the window
 * only draws it. `popupMenu` takes the same template a native `Menu` would and sends a plain
 * description to the window; the pick comes back as an id and runs the item's own `click`.
 */
export interface CtxItem {
  id?: number
  label?: string
  type?: 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  danger?: boolean
  submenu?: CtxItem[]
}

type Click = NonNullable<MenuItemConstructorOptions['click']>

let nextToken = 0
const open = new Map<number, Map<number, Click>>()

/** Turn a template into what the window can draw, remembering each item's click handler. */
export function describe(
  template: MenuItemConstructorOptions[],
  handlers: Map<number, Click>
): CtxItem[] {
  const out: CtxItem[] = []
  for (const t of template) {
    if (t.visible === false) continue
    if (t.type === 'separator') {
      // No doubled or edge separators.
      if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' })
      continue
    }
    const item: CtxItem = { label: String(t.label ?? '') }
    if (t.enabled === false) item.enabled = false
    if (t.type === 'checkbox' || t.type === 'radio') {
      item.type = 'checkbox'
      item.checked = t.checked === true
    }
    if (Array.isArray(t.submenu)) item.submenu = describe(t.submenu, handlers)
    else if (t.click) {
      item.id = handlers.size + 1
      handlers.set(item.id, t.click)
    }
    // A destructive entry reads as one: the label says it (Delete, Remove, Discard).
    if (/^(delete|remove|discard|clear)\b/i.test(item.label ?? '')) item.danger = true
    out.push(item)
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/** Show a menu at the pointer, in `win`. */
export function popupMenu(win: BrowserWindow, template: MenuItemConstructorOptions[]): void {
  const handlers = new Map<number, Click>()
  const items = describe(template, handlers)
  if (!items.length || win.isDestroyed()) return
  const token = ++nextToken
  open.clear() // one menu at a time
  open.set(token, handlers)
  const p = screen.getCursorScreenPoint()
  const b = win.getContentBounds()
  win.webContents.send('ctxmenu:show', { token, items, x: p.x - b.x, y: p.y - b.y })
}

export function registerCtxMenuIpc(): void {
  ipcMain.on('ctxmenu:pick', (e, token: number, id: number) => {
    const handlers = open.get(token)
    open.delete(token)
    const click = handlers?.get(id)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (click && win) click({} as never, win, {} as never)
  })
  ipcMain.on('ctxmenu:close', () => open.clear())
}
