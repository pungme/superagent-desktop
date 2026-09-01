## Superagent 1.7.8 — the real fix for the app disappearing and the browser going blank

1.7.7 closed one narrow race in this area; this release fixes the actual cause. A real capture from a live session showed the app flipping in and out of the Dock and Mission Control **70+ times in under two minutes** while an agent was actively working — that flapping is what "the app keeps disappearing," "I have to fight to open it," and the browser pane needing a full restart to come back were all one symptom of.

- The app hides itself from the Dock for a moment during a background action, so a page load can't yank the window to the front. The timer that was supposed to keep one continuous agent session as *one* hidden period was sized for a single narrow case and was far too short for real tool-call pacing — so it kept letting go and immediately re-grabbing, for the whole length of an active session instead of a brief flicker. Widened, so a real burst of activity now reads as one period, not dozens.
- Separately: a browser pane taken off-window during that period was only ever told to come back when the app received an actual click-to-focus. If you stayed in another app for the rest of the session (very normal — watching an agent work rarely means staring at nothing else), that pane could be left waiting indefinitely. It now asks to come back the moment the hidden period ends, whichever way that happens — not only on a click.

If you're on 1.7.7 and mid-way through this right now: quit and relaunch to clear the stuck state immediately; this build stops it from happening again.
