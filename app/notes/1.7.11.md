## Superagent 1.7.11 — files follow the conversation

**Files showed the wrong copy of the project.** A chat on its own worktree works in a private copy, but the Files panel, the file viewer and the phone's file browsing were all rooted on the project itself. So the agent would write a report inside the chat's worktree, say where it was, and the tree beside the conversation would not have it — the file existed, in a directory nothing on screen pointed at. All three now follow the conversation: its own worktree when it has one, the project otherwise.

**A file the agent hands you stays handed over.** Opening one used to be a moment: it revealed the file for whoever was looking, which is nobody if you are on your phone, or if you come back tomorrow. It now leaves a card in the conversation with the name and where it lives, and clicking it opens the file the same way the tree does. The card reaches the phone too, where tapping it opens the file in the viewer — a generated PDF, an export, a report, still there in the transcript days later.

**Your phone can see the simulator.** A conversation with an iOS Simulator on screen now mirrors it to the phone the way it already mirrored the browser: the device's name, a picture about once a second, and taps that land — the phone's tap goes to the same injector the pane's does.

**Pairing a phone by link stopped eating its own code.** Showing the pairing code again minted a new secret, and leaving Settings cancelled the pairing outright — which is exactly what you do after copying the link. A copied link now stays valid for the two minutes it promises.
