# Superagent 1.9.8

- **One agent per conversation.** A message from the phone could start a second agent on a conversation whose first was still working. The two ran in the same folder without knowing of each other, and both replied. Starting an agent for a conversation now stops the one already running for it.
- **A stopped agent stops.** An agent in the middle of a turn could carry on after being asked to stop, unseen by the app. One that is still running four seconds later is now ended.
- **A record of why.** Every agent start, stop and exit is written to `agents.log` in the app's data folder, with the reason, so a session that ends unexpectedly can be explained.
