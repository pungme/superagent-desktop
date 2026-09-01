## Superagent 1.7.23 — a Codex conversation works from your phone

**Messages from the phone reached Codex with Claude Code's settings.** The phone's Model and Mode pickers are Claude Code's — `opus`, `bypassPermissions` — and it had no way to know a conversation was on Codex. Those are not settings Codex ignores; they are settings it refuses to start with. So a message sent from the phone to a Codex conversation produced no reply at all. The Mac now drops anything belonging to the other agent and uses its own default, which fixes this for phones that have not updated. It also tells the phone which agent each conversation is on, so it can stop guessing, and lets the phone move a conversation between agents.

**When an agent dies, the phone is told.** This window has always shown a banner; the phone was told only that the spinner had stopped, so a conversation whose agent could not start sat there with no reply and nothing to explain it. It gets a notice now.

**"Make sure it's installed and you're signed in" only appears when that is true.** Every agent exit showed it — including a session that ran for an hour and then ended, which is not a setup problem and should not read like one. An ended session now says so, and Retry picks it up where it left off.
