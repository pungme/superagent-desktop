## SuperAgent 1.7.0 — your Mac's agent, on your phone

Pair the SuperAgent iPhone app once and it follows your Mac from anywhere: read the conversation as it happens, send a prompt, start a chat, and answer what the agent asks — from the sofa or the other side of the world.

### Phone companion
- **Pair from Settings → Phone.** Scan the QR with the iPhone app, check the six-digit code matches, accept. That's the whole setup — it works behind any network, nothing to configure.
- **Live from anywhere.** Transcripts stream to the phone as the agent works; send a message or start a new chat from there. Branch chips, chat previews, slash commands, and per-chat model/mode all carry over.
- **Ask mode.** A new permission mode in which the agent checks with you before it acts — on the Mac, or on your phone if that's where you are. Approve or deny from the notification.
- **Push when it matters.** A banner when the agent is done, needs you, or is waiting on an approval — only to phones that aren't already looking.
- **Private by construction.** Everything between the phone and the Mac is end-to-end encrypted with a key that exists only in the pairing QR. Both sides dial out to a small blind relay that forwards ciphertext and stores nothing; run your own with one command and change the URL in Settings → Phone.
- **Connects only when it's used.** The Mac opens its relay connection when a phone is paired or being paired — an install that never pairs never connects anywhere.
- **In the menu bar** while a phone is paired: relay status, open, pair. An option keeps the Mac awake while a phone is paired, for a machine that lives at home as the agent box.
- The iPhone app is built from source for now (superagent-ios).

### Also in this release
- **Simulator snip happens on the phone.** ✂ Snip (or ⌘⇧S) freezes the picture where it is and you drag right on it — no more separate popup. The crop is at the device's native resolution.
- **@ reaches other projects.** Type `@` and the other projects in your sidebar are offered by name; picking one inserts its path and lets you drill in folder by folder. `@/` and `@~/` complete any path on the disk.
- **Sidebar:** rows are compact again; a group highlights as a card when you hover it, so you can see what belongs to it without the column getting taller.
- **Composer:** Attach is a pill in the Model/Mode row instead of sitting inside the text box; the Reply button on long assistant messages is no longer cut off at the edge; the working indicator lines up with the messages.
- **Background jobs:** one Hide/Show for the whole strip (it folds to a one-line count) instead of a per-job Hide that quietly forgot the job.
- README rewritten for what the app is now.
