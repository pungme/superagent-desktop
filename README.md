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

![SuperAgent — the agent driving a real web page in the in-app browser, side by side with the chat](docs/hero.png)

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

Projects group the way you think about them, with each conversation nested
underneath. A spinner while the agent works, a dot when it needs you, the git
branch where you'd expect it.

<p align="center"><img src="docs/sidebar.png" width="300" alt="The sidebar: grouped projects with nested chats and branch chips"></p>

Settings stay short enough to read in one go — including how much the agent is
allowed to do without asking.

<p align="center"><img src="docs/settings.png" width="520" alt="Settings: appearance, agent permissions, developer mode"></p>

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
