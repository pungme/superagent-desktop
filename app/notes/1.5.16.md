## SuperAgent 1.5.16

### Worktrees & branches without the terminal
- **New-worktree branch picker** — the ▾ next to "New worktree" lets you open an existing branch in its own worktree, or branch off HEAD by name. The plain button still does the fast auto-named worktree.
- **Switch branches from the top** — the branch chip in the toolbar is now a switcher: click it to check out another branch in place. Branches already open in a worktree are greyed (git won't check one out twice), and a dirty tree shows git's own error inline.

### Fixes
- **Reveals open in the right session** — booting a simulator, or opening a file/PDF/preview, from one chat and then switching to another no longer pops it open over the session you moved to. It opens on the chat that asked, and appears when you return to it.
- **No more stuck spinner** — a project would sometimes keep spinning after its work was done (a background/worktree chat reaped on switch-away never reported "done"). The spinner now reflects what's actually running.
- **Group drag no longer looks like "drop inside a folder"** — dragging a group to reorder showed a misleading insertion line inside other folders; it now shows a clear "place the group here" line instead.

### Also in this release
- **Attach files** to a message with the 📎 button in the composer.
- **Model picker** matches Claude Code's `/model` — correct order and descriptions (Opus, Fable, Sonnet, Haiku).
- **Stop** background jobs and dev servers, not just hide them.
- **Done notifications** quote the actual reply instead of a stale error.
- **Computer dock** reveals only near the very bottom edge — no more accidental triggers.
