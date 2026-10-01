# Superagent 1.9.2-beta.23

- **A project that is a folder of repos now gives each new chat its own copy.** On its first message a chat gets a working copy of every repo in the folder, all on one branch, so several chats can work on the project at once without touching each other's files. Until now this only happened when the project itself was a single repo. Chats you already have stay where they are.
- **Keep and Throw away work across the repos.** Keep adds one change to each repo the chat touched, and checks all of them first: if one clashes, nothing is kept anywhere and the message says which repo. The sidebar still shows one row per chat.
- **Antigravity.** A third agent beside Claude Code and Codex, switchable per chat. Install the `agy` CLI and run `agy` in Terminal to sign in, then pick Antigravity in the chat's agent picker.
- **A chat waiting on a background agent keeps running.** It used to be shut down after five minutes off screen, which stopped the agent it was waiting for and left the chat stuck.
- **Two chats that open with the same words each get their own branch.** The second used to end up working in the project folder.
- **A new chat's copy can build straight away** when the project keeps its dependencies one folder down (such as `app/node_modules`).
