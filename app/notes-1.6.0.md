## SuperAgent 1.6.0 — every chat is its own checkout

Two chats on the same project used to share one working directory: when one agent switched branches, the other's files changed underneath it. That's over.

### The new model
- **New chat = its own copy.** On a git project, every conversation automatically gets a private copy of the project on its own branch. Agents can edit, branch, and commit side by side without ever touching each other — or your checkout.
- **Keep / Throw away.** When a chat has changes, two buttons appear at the top: **Keep** adds everything it did to the project as one change (named after the chat) and closes it; **Throw away** deletes it all. Also in the chat's right-click menu.
- **Deleting a chat with unkept changes asks first** — Keep, Throw away, or Cancel. Clean chats delete silently.
- **Names that make sense.** The chat's branch is named after its title ("Fix the flaky auth test" → `fix-the-flaky-auth-test`) and follows renames. The sidebar shows the branch each chat is actually on — including one you asked the agent to create.
- **Your work always lands where it came from.** Keep merges onto the branch the chat was started from, even if you've switched the project to another branch since — without touching what you have checked out.
- **No re-installs.** Dependency folders (node_modules, .venv, vendor, target) are shared into each chat's copy automatically.
- Projects without git (or without a first commit) keep working exactly as before, with a small note in the chat.

### Also in this release
- The "What's new" popover no longer gets cut off by the browser pane.
- The branch menu has its background back (was transparent).
- File names in the Files panel read at full strength (no more "faded" look).
- A calmer thinking indicator — the app mark with a breathing dot.
