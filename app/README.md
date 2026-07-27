# Cove — app/

The Electron app (main / preload / renderer). See the [root README](../README.md)
for what Cove is and its features.

Common commands (run from this `app/` directory):

```bash
npm install
npm run dev          # launch in development
npm test             # unit tests (vitest)
npm run test:e2e     # end-to-end smoke tests (Playwright + Electron)
npm run build        # typecheck + compile main/preload/renderer
```

Layout:

- `src/main` — Electron main process (windows, the streaming `claude` agent, browser panes, MCP server, hooks, routines, SQLite store)
- `src/preload` — the `window.cove` context-bridge API
- `src/renderer` — the React UI (sidebar, chat, browser pane, file tree, panels)
