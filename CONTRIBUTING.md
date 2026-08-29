# Contributing to Superagent

Thanks for your interest! Superagent is an Electron + React + TypeScript desktop
app that wraps AI coding agents (Claude Code first). It ships **no AI of its
own** — all intelligence comes from the user's own agent subscription — so
contributions should keep that principle: Superagent is plumbing (chat UI,
browser, scheduler), not a model.

## Getting started

```bash
cd app
npm install
npm run dev
```

Requires Node 18+ and the `claude` CLI on your PATH (sign in once with `claude`).

## Before you open a PR

```bash
npm run typecheck   # tsc, main + renderer
npm run lint        # eslint (0 errors expected)
npm test            # unit tests (vitest)
npm run test:e2e    # end-to-end smoke tests (Playwright + Electron)
```

Please add tests for new logic and keep the suites green.

## Project layout

- `app/src/main` — Electron main process (windows, the streaming `claude` agent,
  browser panes, the MCP browser server, hooks, routines, SQLite store)
- `app/src/preload` — the `window.cove` context-bridge API (internal namespace)
- `app/src/renderer` — the React UI (sidebar, chat, browser pane, file tree, panels)

See [PLAN.md](PLAN.md) for the architecture and roadmap.

## Conventions

- TypeScript throughout; match the surrounding style (Prettier-formatted, plain CSS).
- Keep the renderer sandbox-safe: no Node access outside the preload bridge.
- Never commit secrets, build output, or generated files.

## License

By contributing you agree your contributions are licensed under the project's
[MIT license](LICENSE).
