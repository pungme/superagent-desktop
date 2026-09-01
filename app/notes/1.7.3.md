## Superagent 1.7.3

- **Reload reloads.** The browser's ⟳ turned into Stop while a page was loading — and a page with one request that never finishes (dev servers do this) is "loading" forever, so the first click did nothing visible. A click now always reloads.
- **⌘R works in every chat.** It reloaded the wrong pane in a project chat. Fixed, and **⇧⌘R** reloads ignoring the cache (View → Reload Page Ignoring Cache).
