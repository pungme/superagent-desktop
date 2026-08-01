# SuperAgent

**A friendly home for Claude Code — and other coding agents.**

Your coding agent already writes the code. SuperAgent gives it a place to work:
many conversations per project, a browser it can actually drive, files you can
read next to the chat, and tasks that keep running on a timer. Quiet,
keyboard-driven, and built to look like it belongs on a Mac.

![SuperAgent — a scheduled routine running against a live site in the in-app browser](docs/hero.png)

> **SuperAgent ships no AI of its own.** It's pure plumbing — chat UI, browser,
> scheduler, dictation. All the intelligence comes from an agent you already pay
> for, running on your machine under your own subscription.

---

## Build it and watch it, side by side

The chat sits next to a real Chromium pane. Ask for a change, and watch the page
update in the same window — no alt-tabbing to a browser to find out whether it
worked. Point it at a local dev server or any live site.

<!-- docs/preview.png — chat on one side, the running site on the other -->

## An agent that can use the browser

Claude drives that same pane through MCP: open a page, click, type, read it
back, screenshot it. Not a headless browser it describes to you second-hand —
the one on your screen, with your logged-in session. You watch it work, and you
can take over at any point.

<!-- docs/browser.png — the agent mid-navigation, "Claude is browsing…" showing -->

## Everything in its place

Projects group the way you think about them, with each conversation nested
underneath. A spinner when the agent is working, a dot when it needs you, the
git branch where you'd expect it.

<p align="center"><img src="docs/sidebar.png" width="300" alt="The sidebar: grouped projects with nested chats, branch chips and a working spinner"></p>

Settings stay short enough to read in one go — including how much the agent is
allowed to do without asking.

<p align="center"><img src="docs/settings.png" width="520" alt="Settings: appearance, agent permissions, status badges, developer mode"></p>

## The small things

- **Many chats per project**, nested in the sidebar. They name themselves after
  what the conversation turned out to be about; starting one never discards another.
- **Click any file to read it** — PDFs, images, HTML, markdown, source — in the
  pane beside the tree.
- **Push-to-talk dictation.** Hold <kbd>⌥</kbd><kbd>Space</kbd>, speak, release.
  Whisper runs on your Mac; the audio never leaves it.
- **Quiet tool activity** — a batch of calls folds into one line you can expand,
  instead of a wall of noise.
- **Inline diff cards** the moment a file changes, showing only the real change.
- **Routines** — "check this site every hour" in plain language, on a timer.
- **Live task list**, straight from the agent's own to-dos.
- **Light and dark**, following the system, in a monochrome palette that stays
  out of the way.

<!-- docs/chat.png — a chat mid-turn: collapsed steps, a diff card, the task list -->

## Roadmap: any agent, not just one

The architecture is deliberately thin — SuperAgent shells out to an agent CLI and
renders its event stream — so it isn't tied to one vendor by design. **Today it
drives Claude Code only.** Codex CLI and Gemini CLI are the next targets; each
needs its own launcher and stream parser, since the flags and event formats
differ. See [PLAN.md](PLAN.md).

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
(`~/Library/Application Support/superagent/cove.db`). Conversations are the
agent's own sessions, so anything started here stays resumable from a terminal.

## License

[MIT](LICENSE)
