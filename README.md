# Cove

*A friendly terminal for Claude Code — and other coding agents.*

Cove is a clean, prosumer-friendly macOS app built around AI coding agents:

- **Arc-style sidebar** — group your projects, see at a glance which agent is working, which needs you
- **Two ways to work** — **Terminal** runs the real Claude Code TUI; **Easy Mode** is a calm chat that drives the same `claude` binary
- **Built-in browser** — preview the site your agent is building, right next to the work
- **Agent-driven browsing** — Claude Code can open, click, and test your site through Cove's browser (via MCP)
- **Routines** — "check my site every hour" in plain language, run on your own Claude subscription
- **Skills panel** — your Claude Code skills, visible and one click away
- **Light & dark themes** — a premium Light/Dark/Auto appearance that follows your system

### Easy Mode (a Codex-style chat for Claude Code)

Easy Mode renders Claude Code as a polished chat while still driving the real `claude` binary on your own subscription:

- **Rich markdown** with syntax-highlighted code blocks and one-click copy
- **Inline diff cards** when Claude edits a file (red/green, only the real change)
- **@-file mentions** — type `@` to reference project files with autocomplete
- **Live tool activity** — compact chips showing what Claude is doing, plus its thinking
- **Stop** to interrupt a generation (keeps the session), **New chat** to start fresh
- **Starter suggestions**, an auto-growing composer, a working timer, and smart auto-scroll

**Cove ships no AI of its own.** It's pure plumbing — terminal, browser, scheduler, chat UI. All intelligence comes from your own agent subscription (Claude Code first; Codex CLI and Gemini CLI planned).

> Early but functional. See [PLAN.md](PLAN.md) for the full roadmap.

## Develop

```bash
cd app
npm install
npm run dev
```

## Test

```bash
npm test          # unit tests (vitest)
npm run test:e2e  # end-to-end smoke tests (Playwright + Electron)
```

## Build a macOS app

```bash
npm run build       # compile main/preload/renderer
npx electron-builder --mac   # → dist/Cove-<version>.dmg
```

The build is currently **unsigned / not notarized** (there's a placeholder Apple
Development signature for local runs). For public distribution you'll need an
Apple Developer account and to enable notarization in `electron-builder.yml`.

## License

[MIT](LICENSE)
