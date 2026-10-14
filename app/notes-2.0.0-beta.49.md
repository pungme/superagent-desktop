# Superagent 2.0.0-beta.49

**Deleting a chat whose work is already in the project deletes it.**

- **Keep no longer leaves the chat behind with "Nothing to keep".** Deleting a chat that had commits on its branch asked Keep or Throw away. If those changes were already in the project (kept before, or the same as what the project has now), Keep said "Nothing to keep — this chat didn't change anything" and stopped, and the chat stayed where it was. There is nothing to lose there, so Keep now closes it.
