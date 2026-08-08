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

![SuperAgent — a Monet at the Met open in the browser pane as a desktop page and an iPhone side by side, with the agent that opened it explaining the painting in the chat beside them](docs/hero.png)

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
- **A board the agent keeps.** Backlog, next, doing, done — per project, and
  Claude moves the cards as it works. Watch them move while you talk to it.
- **Worktree chats.** Start a chat on its own git worktree; the agent works on
  an isolated branch while your checkout stays clean.
- **Dashboard.** Turns per day, tasks done, a streak — and which projects
  actually got your time. Computed locally.
- **An iPhone in the window.** Run an iOS Simulator *inside* the app — the real
  device playing live in the pane, tap and type included, while Apple's own
  window stays out of your way.
- **Files & PDFs.** Drag files into the chat and annotate PDFs in place, right
  beside the tree.
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

  THE FRAME SOURCE. There is a native one, and it works — PROVEN 2026-08-08.
  CoreSimulator hands out the device's framebuffer as an IOSurface, in-process,
  no permissions, no screenshots, no window capture. Verified end to end: pulled
  a 1179x2556 BGRA surface off a booted iPhone 16 and wrote it out as a PNG of
  the real screen, clock and all.

    dlopen /Library/Developer/PrivateFrameworks/CoreSimulator.framework
    dlopen <Xcode>/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework
    SimServiceContext sharedServiceContextForDeveloperDir:error:
      -> defaultDeviceSetWithError: -> devices -> the one with state == 3
    device.io.ioPorts -> the descriptor conforming to SimDisplayIOSurfaceRenderable
      -framebufferSurface                              -> IOSurface, BGRA, native res
      -registerCallbackWithUUID:ioSurfacesChangeCallback:
      -registerCallbackWithUUID:damageRectanglesCallback:   (from SimDisplayRenderable)

    Gotchas, all hit for real:
      * Only the FIRST display port returns a surface; the other two are nil.
      * The descriptors are ROCKRemoteProxy objects. KVC throws
        (NSUnknownKeyException) — use performSelector / NSInvocation.
      * SimulatorKit.SimDisplayView is an NSView with -setDevice: and it accepts
        a SimDevice happily, but on its own it renders nothing: intrinsicContentSize
        stays 0x0 and its layer has no contents. The display port still has to be
        attached. Grabbing the IOSurface directly is the simpler path.

  WHY THE EXISTING TOOLS FAIL, and why that misled us. idb_companion 1.1.8 from
  brew reports a build date of AUG 2022 and baguette is 0.1.88; both mount a
  surface and emit zero frames on Xcode 26.5. The earlier conclusion here — that
  Apple had broken framebuffer streaming — was wrong. Simulator.app renders fine,
  so the API works; those clients simply predate the current ROCK remoting layer.
  Two old tools failing the same way is evidence they are both old, not that the
  platform is shut.

  WHAT SHIPS TODAY, and what should replace it. `simctl io screenshot` at ~530ms
  a frame (the mirror's ~2fps ceiling), and Chromium window capture of
  Simulator.app for the live view, which costs a Screen Recording grant. Both
  become unnecessary once the IOSurface path is wired up: a small native addon
  that grabs the surface, registers the damage callback and hands frames to the
  renderer would be faster than either, need no permission at all, and not care
  whether Simulator.app is even open.

  INPUT. baguette's gesture side works, on every runtime — CORRECTED 2026-08-08.
  This note used to claim iOS 26+ only, and the pane shipped a version gate that
  disabled tapping on anything older. Both were wrong: the original measurement
  aimed at empty space, so of course nothing changed. Re-measured against real
  controls — a Continue button on 26.5, a banner dismiss and Safari's tab button
  on 18.6 — and every tap registered, including one dispatched through the pane.
    Watch for this shape of mistake: a tap that changes nothing is not evidence
    of a broken injector. Aim at something that must react.
    idb's `hid` rpc remains an alternative (13ms warm vs baguette's 56ms) but
    there is no longer a correctness reason to take on idb_companion and a gRPC
    client for it.

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
