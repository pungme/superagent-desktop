# Superagent 2.0.0-beta.66

**After two hard freezes, Superagent now keeps a record of the Mac.** When a Mac freezes and has to be reset, macOS writes no report — there was nothing to read either time. Superagent's `memory.log` (in its data folder) now also records free memory, swap, load, each of its own processes and everything its agents spawned: a line every five minutes, and at once when memory or swap is under pressure or the app notices it was not being scheduled. If it happens again, that file says what was eating the Mac.

**The menu-bar icon no longer animates.** While any chat had an agent working — on a busy Mac, always — the icon redrew every 700 ms, 86 menu-bar redraws a minute through the window server. It is still now, and changes only when the state does.

**Flip through a chat's pictures.** With a picture open full size, ← and → (or the arrows at the sides) go to the previous or next picture in the conversation; the bar shows "3 of 12".

**Pictures an agent showed stay in the chat after their file is gone.** Agents like to draw into `/tmp`, which macOS empties on restart; the reply kept only the path, and showed a file name instead. A copy is now kept the first time a picture is shown.

**The project header names the conversation.** `wepush › Fix the header`, with the folder path after it, so a glance at the top says where you are.

**Off means no dot** (from beta.65, which never published). A dot window found on screen while the setting is off is closed, whatever put it there, and that is logged.
