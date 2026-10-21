# Superagent 2.0.0-beta.72

**"Superagent could not finish saving" no longer traps you.** Since beta.64 the app waited for every window to save before quitting, and when one window could not answer — a hung or crashed web view in a long-running session — it showed that dialog and stayed open, every time. Now a dead view is skipped, a window that does not answer within 15 seconds is named and you can **Quit anyway** (conversations save as they go, so at most the last moment is at stake), and the event is written to `memory.log`.

**Restart to update saves first.** The restart took the windows down before conversations could save their last second; now every window saves, then the update installs.
