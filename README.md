# SuperAgent

**A friendly home for Claude Code — and other coding agents.**

A clean, prosumer macOS app that turns the `claude` CLI into a real desktop
workspace: many conversations per project, a browser your agent can drive, and
tasks that keep running on a timer.

<!-- Hero: drop a fresh window screenshot over docs/hero.png (⌘⇧4, then Space to
     grab the window) and uncomment the line below. The previous one was removed
     because it showed a UI that no longer exists.
![SuperAgent](docs/hero.png)
-->

> **SuperAgent ships no AI of its own.** It's pure plumbing — chat UI, browser,
> scheduler. All intelligence comes from your own agent subscription
> (Claude Code first; Codex CLI and Gemini CLI planned).

---

## What it does

|  | |
|---|---|
| 🗂 **Projects, grouped** | An Arc-style sidebar of projects you can group and reorder, each showing whether its agent is idle, working, or waiting on you. Drag the edge to resize, or hide it with <kbd>⌘</kbd><kbd>\\</kbd>. |
| 💬 **Many chats per project** | Every project holds as many conversations as you want, nested under it in the sidebar. Starting a new one never discards the old — each keeps its own transcript and resumes with full context. They name themselves after what they turned out to be about; double-click to rename. |
| 📄 **Click a file, read it** | PDFs, images, HTML and text open in a pane right beside the file tree. Anything else hands off to your default app. |
| 🌐 **A browser the agent drives** | A real browser with an omnibar, and MCP tools so Claude can open, click, type and read **live websites** while you watch. |
| ⏱ **Routines** | "Visit this site every hour and follow 5 people," in plain language, on a timer, on your own subscription. |
| 🎙 **Push-to-talk dictation** | Hold the mic button or <kbd>⌥</kbd><kbd>Space</kbd>, speak, release. Whisper runs **on your Mac** — the audio never leaves it, and after a one-time model download it works offline. |
| ✦ **Skills & files, one click** | Browse the project tree and your Claude Code skills without leaving the app. |
| 🌗 **Light & dark** | A monochrome, system-following appearance that stays out of the way. |

## The chat

SuperAgent renders Claude Code as a polished, persistent chat while driving the
real `claude` binary on your own subscription:

- **Rich markdown** — syntax-highlighted code, one-click copy
- **Inline diff cards** when Claude edits a file — red/green, only the real change
- **Quiet tool activity** — a batch of calls collapses to a single line
  (`18 steps · Running ×11 · Reading ×7`); expand it for the full list
- **@-file mentions** and **/-commands** with autocomplete
- **Live task list** — Claude's own to-dos, pinned as it works through them
- **Saved & resumable** — transcripts are stored locally and sessions resume
  (`--resume`) next launch
- **Stop** mid-generation without losing the session, paste images straight in,
  and queue a message while a turn is still running

## Requirements

- macOS (Apple silicon)
- [Claude Code](https://claude.com/claude-code) installed and signed in —
  SuperAgent checks both on first launch

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
npm run build:mac   # → dist/SuperAgent-<version>.dmg
```

The build is **unsigned / not notarized** (there's a placeholder Apple
Development signature for local runs). For public distribution you'll need an
Apple Developer account and to enable notarization in `electron-builder.yml`.

> The app icon and the name "SuperAgent" only appear in a packaged build — in
> `npm run dev`, macOS takes both from the Electron bundle it runs inside.

## Under the hood

```
app/src/main       Electron main — agent process, browser panes, MCP, hooks, SQLite
app/src/preload    The typed bridge exposed to the renderer as window.cove
app/src/renderer   React UI — sidebar, chat, browser, file tree
```

Chats, projects and browsing history live in a local SQLite database
(`~/Library/Application Support/superagent/cove.db`). Conversations themselves
are Claude Code's own sessions, so anything you start here stays resumable from
a terminal too.

> Early but functional. See [PLAN.md](PLAN.md) for the full roadmap.

## License

[MIT](LICENSE)
