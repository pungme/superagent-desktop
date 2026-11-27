# Superagent 2.1.3-beta.55

**Conductor avoids collisions.** Main now sees which files each session has changed, and an "Overlap" line when two sessions touch the same file. Before it starts a parallel session on work that overlaps one still running, it asks whether to add it to that session or wait.

**Tested.** Unit tests for the overlap check and the prompt; e2e with two real worktrees editing the same file. Not yet tested with a live agent.
