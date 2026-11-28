# Superagent 2.1.3-beta.69

**Performance pass.** Measured on a copy of a real, large store (830 MB, 103 chats, 36 projects):
- **Conductor with many sessions no longer freezes the app.** With 22 sessions, opening or refreshing the Conductor ran dozens of git commands on the main thread: the list took 1 to 5.5 seconds and the whole window stalled. Git is now read in the background, a few at a time, and the list answers at once from a cache (3 to 70 ms). The main process stays under 10 ms busy with the view open.
- **Start-up is about twice as fast** (2.9 s to 1.4–1.7 s to a usable sidebar) and the worst freeze at launch fell from 1.36 s to about 0.5 s: project icons were being found one project at a time on the main thread, 60 to 330 ms each; they are now kept between launches and found one at a time with a breath between.
- Every chat window was asking for the Conductor's state on opening; only Main's does now. Panels pause their refreshes while the window is hidden and skip re-drawing when nothing changed. Reading a session's recent messages reads the tail of its log, not the whole log.

**Tested.** Unit tests for the git cache; opt-in perf specs (`PERF=1 npx playwright test e2e/perf`).
