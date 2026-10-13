# Superagent 2.0.0-beta.48

**Keep just keeps, whatever is unsaved in the project.**

- **Keep no longer refuses because the project has unsaved changes.** Edits to files the chat did not touch are left exactly where they are and the merge goes round them. Edits to a file the chat also changed, and anything staged, are set aside for the merge and put back on top of it, the way `git pull --autostash` does: both changes are there afterwards, yours still unsaved. If yours do not fit back (the same lines, changed both ways) the Keep is taken back whole, the folder exactly as it was, and you are told which file. Before, any unsaved change at all got "Save or discard them in the project first, then keep".
- **A pinned chat is marked under its project too, and comes first there.** It was marked only in the Pinned list at the top; under its project it looked like any other chat.
