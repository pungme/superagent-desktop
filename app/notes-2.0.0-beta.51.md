# Superagent 2.0.0-beta.51

**A screenshot can just be deleted, and a delete that fails says so.**

- **Delete, beside Attach & delete.** A screenshot you took by mistake goes to the Trash without being attached.
- **Attach & delete no longer fails in silence.** When the file cannot be moved to the Trash the normal way, it is moved into the Trash folder directly; if that fails too, you are told which file and why, and it is written to `screenshots.log` in the app's folder. Before, the file just stayed on the Desktop with no word.
