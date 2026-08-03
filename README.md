<p align="center">
  <img src="docs/logo.png" width="112" alt="SuperAgent logo" />
</p>

<h1 align="center">SuperAgent</h1>

<p align="center"><b>A friendly home for Claude Code.</b></p>

Your coding agent already writes the code. SuperAgent gives it a place to work:
many conversations per project, a browser it can actually drive, files you can
read next to the chat, and tasks that keep running on a timer. Quiet,
keyboard-driven, and built to look like it belongs on a Mac.

![SuperAgent — the agent driving a real web page in the in-app browser, side by side with the chat](docs/hero.png)

---

## Build it and watch it, side by side

The chat sits next to a real browser. Ask for a change and watch the page update
in the same window — no alt-tabbing to find out whether it worked. Point it at a
local dev server or any live site.

![The chat next to the code it's editing — task list, grouped steps and edits, model and mode pickers](docs/chat.png)

## An agent that can use the browser

Claude drives that same browser: open a page, click, type, read it back. Not a
hidden browser it describes to you second-hand — the one on your screen, with
your logged-in session. You watch it work, and you can take over any time.

<!-- docs/browser.png — the agent mid-navigation, "Claude is browsing…" showing -->

## Everything in its place

Projects group the way you think about them, with each conversation nested
underneath. A spinner while the agent works, a dot when it needs you, the git
branch where you'd expect it.

<p align="center"><img src="docs/sidebar.png" width="300" alt="The sidebar: grouped projects with nested chats, branch chips and a working spinner"></p>

Settings stay short enough to read in one go — including how much the agent is
allowed to do without asking.

<p align="center"><img src="docs/settings.png" width="520" alt="Settings: appearance, agent permissions, status badges, developer mode"></p>

## The small things

- **Many chats per project.** They name themselves after what the conversation
  turned out to be about. Starting a new one never loses the old.
- **Click any file to read it** — PDFs, images, markdown, source — right beside
  the tree.
- **Talk instead of typing.** Hold <kbd>⌥</kbd><kbd>Space</kbd>, speak, let go.
  Your voice is transcribed on your own Mac and never leaves it.
- **Quiet by default.** A burst of activity folds into one line you can open,
  instead of a wall of noise.
- **See every edit** the moment it happens, with just the change highlighted.
- **Routines.** "Check this site every hour," in plain language, on a timer.
- **Light and dark**, following your system.

## What you need

- A Mac
- [Claude Code](https://claude.com/claude-code), installed and signed in

SuperAgent runs on the subscription you already have — there's nothing extra to
buy and no API key to paste.

## Run it

```bash
cd app
npm install
npm run dev
```

## License

[MIT](LICENSE)
