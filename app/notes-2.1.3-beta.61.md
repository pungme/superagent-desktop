# Superagent 2.1.3-beta.61

**Loops survive an update.** When you press "Restart now", the loops that were running are written down with their prompt, interval, round count and paused state, and come back after the restart. A chat that is being told to carry on does not get a loop round on top of that message: its loop continues when that turn ends.

**Tested.** Unit tests for saving and restoring (once only, paused stays paused, a deleted chat or an old note is skipped, no round on top of the carry-on). Not yet with a real update install.
