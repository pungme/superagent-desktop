# Superagent 1.8.7

- Fixed the transcript jumping up on every keystroke when typing in a long chat. The real cause: a chat that contained a message stored twice (a leftover from the phone double-send bug) rendered two rows with the same key, and each keystroke leaked a new row — pushing the view up. 1.8.6's scroll-anchoring change couldn't stop this; this release removes the duplicate and guarantees unique rows.
