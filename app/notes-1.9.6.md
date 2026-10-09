# Superagent 1.9.6

- **One chat can no longer kill the others.** A chat cleaning up after itself with `pkill -f xcodebuild` (or any word that appears in Superagent's instructions to the agent) ended every other chat's Claude session mid-reply. The instructions travelled on each session's command line, which is what `pkill -f` searches. They now go to the agent in a file, for chats and routines.
- **A loop runs until you stop it.** The agent can no longer end a loop, and the 100-round limit is gone. When a round finds nothing to do, the agent says so and the wait before the next round grows: 1 minute, then 5, 15, 30, up to 60. A round that does real work, or a message from you, brings back the short wait.
- **Blocked on you means held, not ended.** If the agent cannot go on without you, the loop shows "Waiting for you" and carries on when you reply.
- **Quiet rounds fold away.** Rounds that found nothing to do show as one line ("Checked 4 times, nothing to do") that you can open.
- **A session that ends by itself restarts.** The chat says what happened, starts the session again and, if it was cut off mid-reply, asks the agent to carry on. A session that keeps ending still gets the Retry banner.
