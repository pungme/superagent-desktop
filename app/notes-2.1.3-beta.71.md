# Superagent 2.1.3-beta.71

**Compact your conversations.** Settings → Advanced → Storage now says how much free space is sitting inside the conversation stores (deleted and cleared chats leave it behind: 260 MB of an 830 MB store on one Mac) and gives it back with **Compact…**. Superagent restarts to do it, shows "Compacting your conversations…" for about a minute, and opens as usual; nothing is deleted, and chats that were working carry on afterwards, as after an update. It checks there is room on the disk first, never runs twice from one click, and Settings says what it did next time ("830 MB → 570 MB").

The storage total now counts the transcript store too, which it had been leaving out.

**Tested.** Unit tests on a store with deleted rows (the space comes back, the data stays, the request runs once); e2e with the app itself: measured, compacted on the next start, the store smaller, the app up as normal.
