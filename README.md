# Cove

*A friendly terminal for Claude Code — and other coding agents.*

Cove is a clean, prosumer-friendly macOS app built around AI coding agents:

- **Arc-style sidebar** — group your projects, see at a glance which agent is working, which needs you
- **Easy Mode** — a calm chat UI for Claude Code, or the full **Terminal** when you want it
- **Built-in browser** — preview the site your agent is building, right next to the work
- **Agent-driven browsing** — Claude Code can open, click, and test your site through Cove's browser (via MCP)
- **Routines** — "check my site every hour" in plain language, run on your own Claude subscription
- **Skills panel** — your Claude Code skills, visible and one click away

**Cove ships no AI of its own.** It's pure plumbing — terminal, browser, scheduler, UI. All intelligence comes from your own agent subscription (Claude Code first; Codex CLI and Gemini CLI planned).

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
