# Superagent 2.1.3-beta.60

**Conductor, the way the mockup has it.**
- Start Conductor, and a **Conductor** section appears in the sidebar under Routines, one row per project you have started one for. Pick one to open its Main chat with the Sessions beside it.
- Sessions and Main no longer sit in the project's chat list.
- The Sessions column is cards on a trunk from Main: title, status, summary or what it wants to run (Approve / Deny on the card), branch, files, time. Filters All / Active / Needs you, and "Connect session".
- No more invented #101 numbers. A session shows its tracker ticket (WD-284) when you named one or Main knew it, otherwise just its title.
- When Main starts a session, a spark runs down the trunk and the new card unfolds out of it. On the phone the new dot pops in.

**Tested.** e2e for the sidebar section, the cards, and the spawn animation; unit tests for tracker keys. Not yet against your real wepush project.
