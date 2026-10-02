# Superagent 1.9.2-beta.25

- **A chat in a folder of repos only copies the repo it changes.** A new chat used to get a working copy of every repo in the folder with its first message: in a folder of nineteen repos that was eighteen checkouts and a new branch in every repo, each showing up under that repo's own project, for a chat that changed none of them. A chat now starts with no copies at all. A repo gets its copy, on the chat's branch, at the moment the agent is about to change it. A chat that only reads or answers questions makes none.
- **Keep and Throw away follow the repos a chat actually changed.** A chat that has changed nothing shows no branch in the sidebar.
- **The agent says which message it is answering.** When its reply is to a message other than your last one, it opens with that message quoted, and the chat shows it the way a messaging app shows a reply.

Chats started on an earlier beta keep the copies they already have.
