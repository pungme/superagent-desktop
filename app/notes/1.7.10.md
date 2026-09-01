## Superagent 1.7.10 — the app-hiding fix, done properly

1.7.8 fixed the runaway version of this (a timer that let go and immediately re-grabbed for the whole length of a session). A fresh capture right after showed a smaller, different version of the same visible symptom still happening: during active browser automation, real focus flickers constantly between this window and whatever else is open — a terminal, the Simulator — and every flicker was releasing the guard (Dock icon and Mission Control back) the instant it fired, with the next automation call re-engaging it before you'd actually settled anywhere.

The guard itself stays — it's the only thing that stops a background page load from raising the window, and removing it brings back the window jumping to the front on its own, a real bug in its own right. Instead, a focus event no longer releases it immediately: it waits a quarter second to see if focus actually holds before touching the Dock. A flicker that reverses itself in a couple of frames never causes anything visible; a genuine return still releases well under a moment.

No feature lost — just no longer reacting to a glance as if it were a decision.
