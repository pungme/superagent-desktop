## Superagent 1.7.9 — reload actually reloads

Pinned down from an exact report: *"asked the agent to update the site, clicked reload, nothing changed — opened it in another browser and the change was there."* That's not a wiring bug, it's caching: the reload button was doing what a normal browser tab does — respecting the page's HTTP cache — and every pane in this app is either a live dev server or a page the agent just edited, where a cached reload can silently hand you back the exact stale response it cached a moment ago.

- Reload — the button, ⌘R, ⇧⌘R, the right-click menu's Reload, and reload from a paired phone — now always fetches fresh, never the cache.
- The reload button shows its spinner for a guaranteed-visible moment every time you press it. A reload of an already-cached local page can finish in a couple of milliseconds, faster than a frame — so the spin could flip on and off without ever painting, and a click looked like it did nothing even when it worked.
- The Snip button now shows its shortcut (⌘⇧S) directly on the button, not only in a tooltip.

Verified against a server that mimics a real dev server's default headers, with content that changes between requests: before this, reload could show the old version; now it always shows the new one.
