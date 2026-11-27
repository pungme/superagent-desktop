# Superagent 2.1.3-beta.45

A stability release.

**Saving.** A conversation the phone added to while it was open on the Mac is merged and saved instead of stopping with "Transcript changed in another window", at quit too, and when the phone adds a moment after you edit. A save the Mac will always refuse is not resent unchanged for ever. The process that writes conversations starts again if it stops, instead of leaving saving off until a restart.

**Agents.** Changing the permission mode in one chat no longer restarts every open chat's agent (and kills their background monitors). A phone message that carries another agent's model no longer restarts the session. A phone chat is no longer stopped as "idle" while a long command is running.

**The phone.** A phone that was far behind (a long chat, cached events) is sent the end of the conversation instead of thousands of events page by page, which is what froze the app for seconds after a reconnect. The phone also holds less, and asks once per gap rather than once per out-of-order event.

**The window.** If a chat fails while drawing, it shows "This conversation could not be drawn" with Try again, instead of a white window. A crashed window page loads again by itself. If the data file will not open, a message says so instead of an icon with nothing behind it. A browser you close stays closed.
