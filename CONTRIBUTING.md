# Contributing to Superagent

Thanks for your interest! Superagent is an Electron + React + TypeScript desktop
app that wraps AI coding agents (Claude Code and Codex today). It ships **no AI
of its own** — all intelligence comes from the user's own agent subscription — so
contributions should keep that principle: Superagent is plumbing (chat UI,
browser, scheduler), not a model.

## Getting started

```bash
cd app
npm install
npm run dev
```

Requires Node 18+ and at least one agent CLI on your PATH: `claude` (sign in once
with `claude`) or `codex` (sign in once with `codex login`). The app detects both
and lets you pick per chat.

## Before you open a PR

```bash
npm run typecheck   # tsc, main + renderer
npm run lint        # eslint (0 errors expected)
npm test            # unit tests (vitest)
npm run test:e2e    # end-to-end smoke tests (Playwright + Electron)
```

Please add tests for new logic and keep the suites green.

## Project layout

- `app/src/main` — Electron main process (windows, browser panes, the MCP browser
  server, hooks, routines, SQLite store)
- `app/src/main/agent.ts` + `agent-backend.ts` — the provider-agnostic session
  shell and the `AgentBackend` seam
- `app/src/main/claude`, `app/src/main/codex` — one self-contained backend each.
  They do not import one another; a change to one cannot regress the other.
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
