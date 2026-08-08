<p align="center">
  <img src="docs/logo.png" width="112" alt="SuperAgent logo" />
</p>

<h1 align="center">SuperAgent</h1>

<p align="center"><b>The desktop home for Claude Code — one chat, your real browser, and tasks that run themselves.</b></p>

<p align="center">
  <a href="https://github.com/pungme/superagent-desktop/releases/latest/download/SuperAgent.dmg"><b>⬇ Download for Mac</b></a> ·
  <a href="https://superagent.computer/">Website</a> ·
  Apple Silicon · free &amp; open source
</p>

Your coding agent already writes the code. SuperAgent gives it a place to work:
a persistent chat per project, a real browser it can **drive on the sites you're
already logged into**, files you read next to the chat, and routines that keep
running on a timer. Everything runs locally on your Mac, on your own Claude
subscription — no middleman server, and the whole app is open source, so you can
read exactly how it touches your browser. Quiet, keyboard-driven, and built to
look like it belongs on a Mac.

![SuperAgent — a Monet at the Met open in the browser pane, with the agent that opened it explaining the painting in the chat below](docs/hero.png)

---

## Build it and watch it, side by side

The chat sits next to a real browser. Ask for a change and watch the page update
in the same window — no alt-tabbing to find out whether it worked. Point it at a
local dev server or any live site.

![The chat next to the code it's editing — the file tree, grouped steps and edits, model and mode pickers](docs/chat.png)

## An agent that can use the browser

Claude drives that same browser: open a page, click, type, read it back. Not a
hidden browser it describes to you second-hand — the one on your screen, with
your logged-in session. You watch it work, and you can take over any time.

<!-- docs/browser.png — the agent mid-navigation, "Claude is browsing…" showing -->

## Everything in its place

Plain browser tabs sit at the top of the sidebar — browse first, summon the
agent when you need it. Below them, projects group the way you think about
them, with each conversation nested underneath. A spinner while the agent
works, a dot when it needs you, the git branch where you'd expect it.

<p align="center"><img src="docs/sidebar.png" width="300" alt="The sidebar: grouped projects with nested chats and branch chips"></p>

Settings stay short enough to read in one go — including how much the agent is
allowed to do without asking.

<p align="center"><img src="docs/settings.png" width="520" alt="Settings: appearance, agent permissions, developer mode"></p>

## The bigger things

- **Desktop & phone at once.** One click shows the same page in a desktop card
  and an iPhone frame — same session, both live.
- **A desk, not a slot.** The page you're on and an iOS Simulator sit side by
  side on the same surface, over a Monet you can switch off.
- **Worktree chats.** Start a chat on its own git worktree; the agent works on
  an isolated branch while your checkout stays clean.
- **Dashboard.** Turns per day, tasks done, a streak — and which projects
  actually got your time. Computed locally.
- **Files, PDFs & simulators.** Drag files into the chat, annotate PDFs in
  place, and run an iOS Simulator *inside* the app — the real device playing
  live in the pane, tap and type included, while Apple's own window stays out
  of your way.
- **Context gauge.** Every conversation shows how much of the context window
  it has used.
- **Dev server strip.** The agent starts your dev server and iterates while
  you watch the page change, with the server one click away.

## The small things

- **Everything survives a restart** — panes, open files, active chat — even
  through updates.
- **Never steals your focus.** Agents finish quietly in the background; the
  window comes forward only when you ask.
- **Light on memory.** Sessions start on your first message and wind down when
  idle — agents only run while conversations do.
- **Interject mid-turn.** Type while the agent works and it sees your message
  before it finishes — like the terminal.
- **Notifications that say something** — done or has a question, with a summary
  of the agent's actual last reply.
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
- **Updates itself.** Signed, notarized, delivered in the background — restart
  when it suits you.
- **Light and dark**, following your system.

## Roadmap

- **Other agents.** SuperAgent wraps Claude Code today, but in the end it's an
  LLM driving a home — the plan is an agent layer that other CLIs and local
  models can plug into.
- **A desktop.** The pane half is a desk now: your page or file and a simulator
  side by side on a painted surface, arranged the way you left them. Still to
  come — a terminal as a third card, and the agent working across all of them
  at once.
- **Memory that writes itself.** Your agent relearns the same things in every
  new session — your conventions, a project's traps, which command actually
  deploys. SuperAgent should notice those and carry them across projects, in a
  list you can read, edit and delete.
- **Watchers.** Routines already run on a schedule and the browser already
  reads pages. Point one at a page and get told what changed, with a before
  and after.
- **A board the agent keeps.** Kanban/backlog inside the app, maintained by
  the agent as it works: cards move themselves, each links to the chat,
  worktree or PR that did the work, and you can ask what's left.

<!--
  Maintainer note — how the embedded iOS Simulator works, and every route that
  turned out to be a dead end. Not user-facing; kept here so the research isn't
  redone from scratch.

  WHERE WE ARE. Phase 1 shipped in 1.1: `sim_list_devices`, `sim_boot`,
  `sim_screenshot`, `sim_open_url`, `sim_install_and_launch` in src/main/mcp.ts
  — all `xcrun simctl`, public APIs only. Phase 2 shipped in 1.2: a live view
  in the pane. Three modes in src/renderer/src/components/SimulatorPane.tsx:
  live (window capture), mirror (screenshots), attach (park Apple's window).

  WHY IT ISN'T JUST "EMBED THE WINDOW". macOS gives no supported way to
  reparent another application's window into ours. Anything that looks like
  embedding is really capture + input forwarding.

  THE FRAME SOURCE. Everything that reads the simulator's framebuffer through
  Apple's private frameworks is broken on this host, and it is worth knowing
  that before trying again:

    * baguette 0.1.88 — `stream --format mjpeg` writes its multipart HTTP
      header and then zero frames. `--format h264` is rejected as unknown.
      Tried iOS 18.6 and 26.5, headless and visible, static and with motion.
    * idb_companion 1.1.8 (Meta) — its gRPC `video_stream` behaves IDENTICALLY.
      The companion logs "connectToFramebuffer succeeded", mounts the surface,
      prints the scale it will apply — and then emits not one byte, on both
      runtimes, with or without motion. Verified from Node over @grpc/grpc-js
      with proto/idb.proto, not just through idb's Python client.

    Two independent tools failing the same way on Xcode 26.5 / macOS 26.5 says
    the framebuffer API changed under them, not that we held either wrong.

    What DOES work, all public API:
    * `simctl io <udid> recordVideo out.mov` — a real h264 movie. But it is
      AVAssetWriter underneath: a fifo yields nothing and an http:// target is
      rejected ("Cannot create file"), so there is no way to get frames out of
      it while it runs. Only useful for recordings, not a live view.
    * `simctl io <udid> screenshot` — works everywhere, and costs ~530ms per
      frame. That is the mirror's ~2fps ceiling and it can't be tuned away.
    * Window capture of Simulator.app — what live mode uses. Chromium's
      desktopCapturer is ScreenCaptureKit here, it keeps delivering frames for
      an occluded window, and it needs one Screen Recording grant.

  INPUT. baguette's gesture side works and is what ships, but only on iOS 26+:
  on 18.6 a tap reports success and does nothing (measured — the same tap opens
  an app on 26.5). idb's `hid` rpc does NOT have that limit: verified landing
  taps on iOS 18.6, and at 13ms on a warm connection against baguette's 56ms.
  If the "view only" note on old runtimes becomes a real complaint, that is the
  fix — at the cost of idb_companion as a second optional install plus a gRPC
  client in main.

  CROPPING. Window capture returns the window, title bar included. Simulator's
  Window menu exposes checkbox state through AXMenuItemMarkChar (a ✓ when on,
  `missing value` when off) — so "Show Device Bezels" is readable, not just
  settable, and with bezels off the captured content is exactly the screen.
  The bar's height is then arithmetic: see screenCrop() and its unit tests.

  AGENT SURFACE. Still to do: `sim_tap`, `sim_type`, `sim_swipe` alongside the
  phase-1 tools, so the agent drives the device the same way the user does.
-->


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

<!--
  Maintainer note — cutting a Mac release. Not user-facing; kept here so it isn't
  rediscovered the hard way. Signing uses the Developer ID cert in the login
  keychain; notarization credentials live in app/.env (gitignored, template in
  app/.env.example) and a non-interactive shell does NOT inherit them:

      cd app && set -a && source .env && set +a && npm run build:mac

  Two steps fail quietly:

  1. Missing credentials do not fail the build. electron-builder logs "skipped
     macOS notarization" and exits 0 with a signed-but-un-notarized DMG, which
     passes spctl on the build machine and is blocked by Gatekeeper everywhere
     else. Verify before publishing — wants a stapled ticket and
     "Notarized Developer ID", not plain "Developer ID":
         xcrun stapler validate dist/mac-arm64/SuperAgent.app
         spctl -a -vvv -t exec dist/mac-arm64/SuperAgent.app

  2. `notarize: true` covers the app, not the DMG around it. Submit and staple
     the DMG separately, then regenerate latest-mac.yml — stapling changes the
     file, and a stale sha512/size fails the auto-updater's integrity check:
         xcrun notarytool submit dist/SuperAgent-<v>.dmg --apple-id "$APPLE_ID" \
           --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
         xcrun stapler staple dist/SuperAgent-<v>.dmg

  Publishing is not just a file upload: the app auto-updates, so a release rolls
  out to everyone already running it.
-->

## License

[MIT](LICENSE)

The desk background is Claude Monet, *Water Lilies* (1906), from the Art
Institute of Chicago's open-access collection — public domain (CC0).
