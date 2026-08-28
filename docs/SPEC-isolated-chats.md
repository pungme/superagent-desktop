# Spec: every chat is its own checkout

## The problem

Two chats on the same project share one working directory. When chat B runs
`git checkout -b feature`, chat A's files change underneath it — there is only
one `HEAD` in a folder. Users hit this constantly and it reads as "the agents
are confused". They aren't; they're standing in the same folder.

The fix already exists in the app ("New Chat in a Worktree") but it is opt-in
and buried in a right-click menu, so the default path is the broken one.

## The rule

> **A chat is a checkout.** Every chat on a git repo gets its own copy of the
> project on its own branch, automatically. Chats cannot see each other's
> changes until the user keeps them.

The user never sees the words *branch*, *worktree* or *merge*. They see three
things: **New chat**, **Keep**, **Throw away**.

## User journey

1. **New chat** — click it, it opens. The app silently creates a worktree on a
   new branch. No dialog, no choice.
2. **Work** — the agent edits, branches, commits, all inside its own copy.
3. **Another chat** — same again. N agents, N branches, side by side.
4. **Done** — two buttons on the chat: **Keep** (squash-merge into the project,
   clean up) or **Throw away** (delete the copy, clean up).
5. **Remove a chat** — if it has unkept changes, ask *Keep · Throw away ·
   Cancel*. Otherwise it just goes.

If a technical user tells the agent "create a branch called X", that happens
inside the chat's own copy. Same chat, same folder. The sidebar chip updates to
`X`. Nobody else is affected. No new chat is spawned.

## Changes

### 1. New chat always isolates on a repo

**Files:** `app/src/renderer/src/state.ts` (`newChat`, `newChatInWorktree`),
`app/src/renderer/src/components/EasyChat.tsx` (~line 2650), `DesktopChat.tsx`
(~line 83), `app/src/main/index.ts` (`workspace:menu`, ~line 252),
`app/src/renderer/src/App.tsx` (`onWorkspaceMenuAction`, ~line 165).

- `newChat(workspaceId)` becomes: if the workspace is a git repo, do what
  `newChatInWorktree` does today; otherwise create a plain chat as now.
  Non-repo projects are unaffected — there is nothing to isolate.
- Remove the separate **⎇ New worktree** pill in `EasyChat.tsx` and the
  **New Chat in a Worktree** context-menu item. One button: **New chat**.
- Delete `newChatInWorktree` once nothing calls it.
- If `git worktree add` fails (no commits yet, or a dirty index git refuses to
  branch from), fall back to a plain chat **and say so once**: a small inline
  note in the chat, not an `alert()`. Text: *"This project has no commits yet,
  so this chat works directly in the folder."* Today's `window.alert("Couldn't
  create a worktree — git refused")` goes.

### 2. Base the worktree on the project's branch

**File:** `app/src/main/files.ts` (`worktree:create`, ~line 196).

Today: `git worktree add <dir> -b <branch>` — branches from whatever `HEAD`
the project folder happens to be on, which may itself have been moved by an
earlier shared chat.

Change to: resolve the project's current branch first
(`git symbolic-ref --short HEAD` in `projectPath`; fall back to `HEAD` if
detached), then `git worktree add <dir> -b <branch> <base>`. Return `base`
alongside `path` and `branch` so the merge step (§4) knows where to land.

### 3. Name the branch after the chat

**Files:** `app/src/main/files.ts`, `app/src/renderer/src/state.ts`,
`app/src/main/agent.ts` (`suggestTitle`, ~line 558).

Today the branch is `superagent/wt-<base36 timestamp>` and the sidebar chip
shows `wt-a3f9k`. Nobody can read that.

- Keep creating with the timestamp slug — the chat has no title yet at creation.
- When the auto-title lands (wherever `agent:suggestTitle` is applied to the
  chat), rename the branch: `git branch -m superagent/<old> superagent/<slug>`
  run in the worktree. Slug = lowercase, non-alphanumerics → `-`, collapse
  runs, trim, max 40 chars. On collision append `-2`, `-3`.
- Add an IPC `worktree:rename(wtPath, newBranch)` for this. Renaming a branch
  never moves files, so it is safe mid-session.
- Do **not** rename the folder. `cwd` is stored on the chat and the agent is
  running in it.
- Manual rename of a chat title does the same.

The chip in `Sidebar.tsx` (~line 353) should show the **branch**, not the
folder name: read it with the existing `.git/HEAD` reader in `files.ts` (~line
92) rather than parsing the path. This is also what makes "user asked the agent
for branch X" visible — the chip follows `HEAD`.

### 4. Keep / Throw away

**Files:** `app/src/main/index.ts` (`chat:menu`, ~line 197),
`app/src/renderer/src/App.tsx` (`onChatMergeWorktree`, ~line 135),
`app/src/main/files.ts` (`worktree:merge`, ~line 230).

- Rename the context-menu item **Merge & finish…** → **Keep changes…**.
  Dialog copy: *"Keep this chat's changes?"* / *"They'll be added to the
  project as one change. The chat closes."* Buttons: **Keep**, Cancel.
- Add **Throw away…** below it. Dialog: *"Throw away this chat's changes?"* /
  *"Everything it did is deleted. This can't be undone."* Buttons: **Throw
  away**, Cancel. Action = today's `removeChat` path (which already calls
  `worktree:remove`).
- Both items also appear as two buttons at the top of the chat's transcript
  when the chat is a worktree chat **and has changes** (§5 defines "has
  changes"). Not shown for a clean chat — there is nothing to decide.
- `worktree:merge` should merge onto the `base` recorded in §2, not "the
  project's current branch" — if the user has switched the project folder to
  something else since, the chat's work still lands where it came from.
- The error strings in `App.tsx` stay but drop the jargon:
  - `base-dirty` → *"The project has changes that aren't saved yet. Save or
    discard them in the project first, then keep."*
  - `conflict` → *"These changes clash with something already in the project.
    Ask the agent in this chat to resolve it, then keep again. Nothing was
    changed."*
  - `nothing` → *"Nothing to keep — this chat didn't change anything."*

### 5. Guard removal

**Files:** `app/src/renderer/src/state.ts` (`removeChat`, ~line 718),
`app/src/main/files.ts` (new IPC), `app/src/main/index.ts` (`chat:menu`
delete item).

- New IPC `worktree:status(projectPath, wtPath)` → `{ dirty: boolean, ahead:
  number }`. `dirty` = `git status --porcelain` non-empty in the worktree.
  `ahead` = `git rev-list --count <base>..HEAD` in the worktree. "Has changes"
  = `dirty || ahead > 0`.
- Before deleting a worktree chat, call it. If it has changes, show a native
  dialog: *"This chat has changes you haven't kept."* Buttons: **Keep**,
  **Throw away**, Cancel. Keep runs §4's merge then removes; Throw away removes;
  Cancel does nothing.
- No changes → delete silently, as today.
- The **Clear chat…** item (wipes transcript, keeps the row) is unaffected:
  clearing a conversation does not touch its worktree.

### 6. Shared dependencies (do last, verify it helps)

A worktree is a full copy of the tree. Source is cheap; `node_modules`, `.venv`,
`target`, `build` are not, and every new chat would otherwise re-install.

On `worktree:create`, for each of `node_modules`, `.venv`, `vendor`, `target`
that exists in `projectPath` and is git-ignored, symlink it into the new
worktree. Skip anything tracked by git. Log what was linked. If this causes
trouble (some toolchains dislike symlinked `node_modules`), gate it behind a
setting rather than removing it.

## Not in scope

- Chats on non-git folders. They keep working in the folder directly.
- Multiple worktrees sharing one branch (git forbids it; not needed).
- Rebasing a chat onto a newer `main`. Keep merges onto `base` as it was;
  conflicts are reported and left for the agent.

## Acceptance

1. On a repo, click **New chat** twice. Two chats, two folders under
   `.worktrees/`, two branches. `git worktree list` shows both. Neither
   `.worktrees/` nor its contents appear in `git status` of the project.
2. In chat B tell the agent to create and switch to branch `feature-b`. Chat
   A's `git branch --show-current` is unchanged. The project folder's is
   unchanged. Chat B's sidebar chip now reads `feature-b`.
3. Auto-title a chat *"Fix the flaky auth test"*; its branch is now
   `superagent/fix-the-flaky-auth-test`. Rename the chat; the branch follows.
4. **Keep** on a chat with two commits → one squash commit on the project's
   branch with the chat title as message; worktree and branch gone; chat row
   gone; project folder still on the branch it was on.
5. **Throw away** → worktree and branch gone; project untouched.
6. Delete a chat with an uncommitted edit → the three-button dialog appears.
   Delete a clean chat → no dialog.
7. On a folder with no commits, **New chat** opens a plain chat with the inline
   note; no `alert()`.
8. Nothing in the UI shows the string "worktree" to the user except the chip
   tooltip.
