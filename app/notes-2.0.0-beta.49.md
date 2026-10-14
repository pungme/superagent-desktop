# Superagent 2.0.0-beta.49

**A routine can be deleted from the sidebar, and deleting a chat whose work is already in the project deletes it.**

- **Routines have a × in the sidebar.** Point at a routine under its project and a × appears beside ▶; it asks once, then deletes. Before, the only way was a small × in Computer → Routines, which nobody found.
- **Keep no longer leaves the chat behind with "Nothing to keep".** Deleting a chat that had commits on its branch asked Keep or Throw away. If those changes were already in the project (kept before, or the same as what the project has now), Keep said "Nothing to keep — this chat didn't change anything" and stopped, and the chat stayed where it was. There is nothing to lose there, so Keep now closes it.
