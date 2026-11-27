# Superagent 2.1.3-beta.47

**Conductor (experimental).** Right-click a project → **Start Conductor…** (or **Open Conductor** once it is on). A project then has one **Main** chat that you keep writing to. Main starts a session for each piece of work, numbered (#101, #102…) and titled, sends your follow-ups to the right one, answers questions about where things stand, and asks when it is not sure. The project's side panel gets a **Sessions** tab: each session with its status, branch and one-line summary, a **Routing: Confirm / Auto** switch, **Connect** for a chat Main did not start, **Close / Reopen / Detach**, and **Open Main**.

In Confirm (the default) Main talks a new task over and asks before starting a session; in Auto it starts one at once and asks only when a message could belong to two. Closing a session with commits not yet in the main branch asks you first: merge and close, or close and keep the branch.

Works with Claude. The phone drives Main like any other chat. Nothing changes for projects where you do not start it.
