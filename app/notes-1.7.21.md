## Superagent 1.7.21 — Codex, and the page stays where its pane is

**Codex runs alongside Claude Code, switchable per conversation.** Each chat remembers which agent it is on, so one project can have a Claude conversation and a Codex one open at the same time.

**The page stays where its pane is.** A native pane is placed in the window's pixels while the app measures its slot in CSS pixels — the same number only at 100% zoom. Since ⌘+ and ⌘− are easy to hit by accident, a zoomed window drew the page up and to the left of its pane and smaller than it, by exactly the zoom factor, and nothing ever put it back. Three fixes: the conversion itself, a re-measure on every moment that moves a pane (resize, move, fullscreen, maximise, pinch-zoom, a display with a different scale), and a backstop that checks four times a second that the page is still where the pane is and corrects it if not — so a cause nobody has met yet heals in a quarter second.

**Clearing a conversation actually empties it.** It emptied the transcript the window reads but not the event log your phone replays from, so everything came back the moment a phone subscribed — and the rows actually taking the space stayed. It clears both now. And the conversation that works in the project folder can finally be cleared at all: it has no row of its own, so the action is on the project row, which is why the one conversation that grows forever was the one nothing could empty.

**Drag a conversation** to reorder it within its project. Branch rows are left alone — their place comes from git.

**The unread dot survives quitting**, and covers every project rather than only the one you are in.

**Smaller:** the branch chip on a conversation widens on hover instead of showing a tooltip, and Hide sits in the corner of the "running in background" strip.
