## Superagent 1.7.22 — the unread dot means something again

**An old conversation stops growing an unread dot on its own.** A conversation's timestamp is read everywhere as "when something was last said here" — the sidebar sorts by it, Activity orders by it, and the unread dot compares it against when you last had the conversation open. But it was bumped every time the transcript was saved, and the window saves it back on opening a conversation, after a reload, and while a chat is kept alive in the background for work it left running. Nothing had been said; the row had merely been touched. So a conversation from three weeks ago climbed to the top of the list wearing a dot. The clock now moves only when the transcript actually changed.

**The × on a conversation is reachable again.** Hovering a conversation widens its branch chip to show the whole name, and a long one — `add-codex-support-alongside-claude-code` — filled the row and pushed the delete button out from under your pointer. The chip stops short of it now. Introduced in 1.7.21; sorry about that.

**A process Codex leaves running shows up in the runs strip**, the same as one from Claude Code.
