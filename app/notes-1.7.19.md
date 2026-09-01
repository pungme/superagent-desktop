## Superagent 1.7.19 — adding a folder works the first time

**Adding a project did nothing until you did it twice.** The Computer, Chats, the dashboard and Settings are full-window surfaces that cover your projects completely, and the only thing that dismissed them was clicking a row in the sidebar. Creating a project made it the active one without leaving that surface — so the folder you added became the active project behind the screen that hides projects, and nothing appeared to happen. Adding it a second time looked like the fix; clicking the row the first attempt had already made was the actual fix. Every way of creating a project now leaves the surface, and a brand new project opens with a conversation in it rather than an empty pane.

**The unread dot survives quitting the app.** It was set by the chat component noticing a turn finish while you were looking elsewhere — which needs that component mounted, and it is only mounted for the project you are in. A conversation that moved in another project left no mark, and quitting counted as reading everything. Beside that flag there is now a durable mark: when you last had each conversation open, checked against the conversation's own timestamp. Every project, across restarts, and the same rule your phone uses — so the two now agree.

**Drag a conversation where you want it.** The order of a project's conversations was the order they happened to be made in and nothing could change it. Branch rows are left alone: their place comes from git, not from you.

**Hide sits in the corner of the "running in background" strip** instead of wrapping onto a line of its own underneath the jobs, where it read as a third job.
