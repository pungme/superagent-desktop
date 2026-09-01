## SuperAgent 1.6.1 — tap the simulator, nothing to install

Tapping, swiping and typing on the iPhone in the window used to need a separate `brew install baguette`. Not any more.

### What changed
- **Simulator input works out of the box.** The app now ships its own copy of baguette, the open-source helper that drives the Simulator's touch and keyboard input. Boot a device, tap the screen, type into a field — no Homebrew, no terminal, nothing to install first.
- **Nothing is taken from you.** If you already have baguette from brew, the app prefers its own bundled copy (the version it was tested against) and falls back to yours if that one can't start.
- The "brew install baguette" note in the simulator pane is gone for everyone this applies to; it only appears now if the bundled helper fails to launch.

### Also in this release
- The branch chip in the sidebar no longer truncates short branch names in a row with plenty of room; it only ellipsizes when the row is actually tight.
- The attach button sits on the left of the message box, where every chat app keeps it.
