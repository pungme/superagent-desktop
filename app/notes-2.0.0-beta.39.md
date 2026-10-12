# Superagent 2.0.0-beta.39

**A sidebar of conversations, not of git branches.**

- **Branches nobody is talking to fold into one line.** A project with worktrees made outside Superagent, or left behind by an agent, used to list each as a row that said nothing but a branch name. Now only branches with a conversation are rows; the rest are "7 other branches" under the project, closed until you open it (remembered per project).
- **Opened, each says what it is.** A checkout on no branch is "no branch · at c37e2ea" rather than "detached", and the ones already merged into the main line with nothing uncommitted are marked "merged".
- **Clean up.** One button removes those merged ones, after showing you the list. Anything with work of its own, or something uncommitted, is left alone.
- **Removing a second checkout of `main` no longer deletes the branch `main`.** Removing a worktree takes its branch with it; that now never applies to main, master or develop.
- **Images is in the toolbar.** The button for every picture in a conversation sits at the top right of the project's toolbar.
