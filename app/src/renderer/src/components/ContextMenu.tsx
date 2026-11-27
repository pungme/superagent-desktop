import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../state'

/** What main sends (main/ctx-menu.ts): a plain description of a native-style menu. */
interface Item {
  id?: number
  label?: string
  type?: 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  danger?: boolean
  submenu?: Item[]
}

/**
 * The app's own right-click menu. Main builds the items and runs each one's action; this only
 * draws them at the pointer, takes arrows / Return / Esc, and reports the pick.
 */
export function ContextMenu(): React.JSX.Element | null {
  const [menu, setMenu] = useState<{ token: number; items: Item[]; x: number; y: number } | null>(
    null
  )
  const enterOverlay = useStore((s) => s.enterOverlay)
  const exitOverlay = useStore((s) => s.exitOverlay)

  // Where the person right-clicked. Main only knows where the pointer is on the screen, which is
  // not the click in a window nobody is moving a mouse over (a test, a trackpad tap).
  const lastClick = useRef<{ x: number; y: number; at: number } | null>(null)
  useEffect(() => {
    const note = (e: MouseEvent): void => {
      lastClick.current = { x: e.clientX, y: e.clientY, at: Date.now() }
    }
    window.addEventListener('contextmenu', note, true)
    return () => window.removeEventListener('contextmenu', note, true)
  }, [])
  useEffect(
    () =>
      window.cove.onCtxMenu((m) => {
        const c = lastClick.current
        const fresh = c && Date.now() - c.at < 1500
        setMenu({ ...m, items: m.items as Item[], x: fresh ? c.x : m.x, y: fresh ? c.y : m.y })
      }),
    []
  )
  // Native views (a browser pane) sit above the page: hold them back while a menu is up.
  useEffect(() => {
    if (!menu) return
    enterOverlay()
    return () => exitOverlay()
  }, [menu, enterOverlay, exitOverlay])

  const close = (): void => {
    if (menu) window.cove.closeCtxMenu()
    setMenu(null)
  }
  const pick = (id: number | undefined): void => {
    if (!menu || id == null) return
    window.cove.pickCtxMenu(menu.token, id)
    setMenu(null)
  }

  useEffect(() => {
    if (!menu) return
    const off = (e: Event): void => {
      if (!(e.target as HTMLElement)?.closest?.('.ctx-menu')) close()
    }
    window.addEventListener('mousedown', off, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', off, true)
    return () => {
      window.removeEventListener('mousedown', off, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', off, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu])

  if (!menu) return null
  return <MenuList menu={menu} pick={pick} close={close} />
}

function MenuList({
  menu,
  pick,
  close
}: {
  menu: { items: Item[]; x: number; y: number }
  pick: (id: number | undefined) => void
  close: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  const [active, setActive] = useState(-1)
  const [sub, setSub] = useState<number | null>(null)

  // Keep it on screen: flip up / left when it would run off the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(6, Math.min(menu.x, window.innerWidth - r.width - 6)),
      top: Math.max(6, Math.min(menu.y, window.innerHeight - r.height - 6))
    })
    el.focus()
  }, [menu])

  const rows = menu.items
  const usable = (i: number): boolean => rows[i]?.type !== 'separator' && rows[i]?.enabled !== false
  const step = (d: 1 | -1): void => {
    let i = active
    for (let n = 0; n < rows.length; n++) {
      i = (i + d + rows.length) % rows.length
      if (usable(i)) break
    }
    setActive(i)
    setSub(null)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') step(1)
    else if (e.key === 'ArrowUp') step(-1)
    else if (e.key === 'ArrowRight' && rows[active]?.submenu) setSub(active)
    else if (e.key === 'ArrowLeft') setSub(null)
    else if (e.key === 'Enter' && active >= 0) {
      const it = rows[active]
      if (it.submenu) setSub(active)
      else if (usable(active)) pick(it.id)
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      className="ctx-menu"
      ref={ref}
      role="menu"
      tabIndex={-1}
      style={pos}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="ctx-menu"
    >
      <Rows
        items={rows}
        active={active}
        setActive={setActive}
        sub={sub}
        setSub={setSub}
        pick={pick}
      />
    </div>
  )
}

function Rows({
  items,
  active,
  setActive,
  sub,
  setSub,
  pick
}: {
  items: Item[]
  active: number
  setActive: (i: number) => void
  sub: number | null
  setSub: (i: number | null) => void
  pick: (id: number | undefined) => void
}): React.JSX.Element {
  return (
    <>
      {items.map((it, i) =>
        it.type === 'separator' ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <div key={i} className="ctx-row-wrap">
            <button
              role="menuitem"
              disabled={it.enabled === false}
              className={`ctx-row${i === active ? ' active' : ''}${it.danger ? ' danger' : ''}`}
              onMouseEnter={() => {
                setActive(i)
                setSub(it.submenu ? i : null)
              }}
              onClick={() => (it.submenu ? setSub(i) : pick(it.id))}
            >
              <span className="ctx-tick">{it.type === 'checkbox' && it.checked ? '✓' : ''}</span>
              <span className="ctx-label">{it.label}</span>
              {it.submenu && <span className="ctx-caret">›</span>}
            </button>
            {it.submenu && sub === i && (
              <div className="ctx-menu ctx-submenu" role="menu">
                {it.submenu.map((s, j) =>
                  s.type === 'separator' ? (
                    <div key={j} className="ctx-sep" role="separator" />
                  ) : (
                    <button
                      key={j}
                      role="menuitem"
                      disabled={s.enabled === false}
                      className={`ctx-row${s.danger ? ' danger' : ''}`}
                      onClick={() => pick(s.id)}
                    >
                      <span className="ctx-tick">
                        {s.type === 'checkbox' && s.checked ? '✓' : ''}
                      </span>
                      <span className="ctx-label">{s.label}</span>
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        )
      )}
    </>
  )
}
