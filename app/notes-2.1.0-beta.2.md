# Superagent 2.1.0-beta.2

**A much more responsive app while agents and simulators work.**

- **The simulator no longer freezes the app.** The embedded simulator screen checked on its device once a second from the app's main thread, and each check waited on Apple's simulator service. Whenever that service was busy — a build installing, another device booting — the whole app froze with it: in a sample of a busy Mac, 62% of the main thread was spent waiting there, and freezes ran from seconds to minutes. The check now runs on its own thread; the picture and touch are unchanged.
- **An agent finishing a turn no longer makes every project reload.** Each turn's end used to send every project row in the sidebar back to git for its branches and copies — dozens of git processes, some of them run synchronously — and refetch every project's icon. Now only the project that finished refreshes, and a copy's details are read straight from disk.
- **A slow moment explains itself.** When the app's main process stays busy, it now samples itself for a few seconds and writes what it was doing to its log, so the next stutter can be found and fixed rather than guessed at.
