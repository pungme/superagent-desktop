# Superagent 2.1.0-beta.24

**"Running in background" no longer fills up with tasks that ended long ago.** A watcher the agent started (a deploy watch, a log stream) kept its pill forever once it finished by itself or died with an app restart, because the strip only listened for the agent stopping it by name. The strip now follows the agent's own list of live tasks: a task the agent no longer has disappears within seconds, and old pills are cleared when the agent restarts. Leftover pills also kept the chat's agent in memory, so idle chats can be put to sleep again.

**Duplicates fold into one.** Five copies of the same watcher show as one pill with ×5, and a quiet "Stop duplicates" (or "Stop all") asks the agent to stop them in one go.

**At most four at a time.** The agent is now told to check for an existing watcher before starting another, to stop each one when what it waits for has finished, and to prefer watchers with a time limit. With Claude Code, a fifth background task is refused until it stops a finished or duplicate one.

The age on each pill now counts up as it should instead of always saying "1s".
