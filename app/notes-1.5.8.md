### Fixed
- **Switching chats no longer kills a session's background work.** Moving to another chat used to unmount the one you left and stop its `claude` process — taking down any builders or long-running work it had spawned. The chats you were just in now stay live, so switching away doesn't nuke work in flight.

_Note: a full app restart (including installing an update) still ends running work — that's inherent to restarting. The agent resumes its conversation on relaunch, but work that was mid-flight has to be picked back up._
