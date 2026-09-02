import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startOverlayGuard } from './overlay-guard'
import { useStore, applyAccent, applySavedIcon, type Accent } from './state'
import App from './App'

/**
 * Durable UI state: localStorage is the fast synchronous layer the whole app
 * reads, but it lives in a Chromium leveldb that an unclean shutdown can
 * corrupt — and Chromium then resets it wholesale (2026-08-06: onboarding
 * reappeared, pane state gone). SQLite (cove.db, WAL) is the source of truth:
 * 1. Before first render, restore any key SQLite has that localStorage lost.
 * 2. Mirror every write/remove through to SQLite from then on.
 */
async function hydrateStorage(): Promise<void> {
  try {
    const durable = await window.cove.kvAll()
    for (const [k, v] of Object.entries(durable)) {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v)
    }
    // Seed keys that predate the mirror (first run after this feature ships).
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      if (durable[k] !== localStorage.getItem(k)) window.cove.kvSet(k, localStorage.getItem(k)!)
    }
  } catch {
    // No mirror (e.g. tests, stale main) — plain localStorage still works.
  }
  const origSet = Storage.prototype.setItem
  const origRemove = Storage.prototype.removeItem
  Storage.prototype.setItem = function (k: string, v: string) {
    origSet.call(this, k, v)
    if (this === window.localStorage) window.cove.kvSet?.(k, v)
  }
  Storage.prototype.removeItem = function (k: string) {
    origRemove.call(this, k)
    if (this === window.localStorage) window.cove.kvDel?.(k)
  }
}

void hydrateStorage().then(() => {
  // Apply the saved theme before first paint to avoid a dark→light flash.
  const saved = localStorage.getItem('cove.theme') || 'system'
  const resolved =
    saved === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : saved
  document.documentElement.setAttribute('data-theme', resolved)
  // Alongside the theme and for the same reason: applied before the first paint,
  // so the app never flashes the default accent on the way to the chosen one.
  applyAccent((localStorage.getItem('cove.accent') as Accent) || 'default')
  // The Dock icon is the app's own, per launch — a chosen one has to be put back.
  void applySavedIcon()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

  // Dev only, and a no-op in a build: shouts if an overlay mounts over a browser
  // pane without taking the lock, which is the one mistake CSS cannot warn about.
  startOverlayGuard(() => useStore.getState().overlayCount > 0)
})
