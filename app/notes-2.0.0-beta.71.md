# Superagent 2.0.0-beta.71

**The window stops burning a core and a half while agents stream.** With a long conversation on screen, every streamed token re-rendered the whole chat; three chats streaming at once put the window at 150% CPU. Streaming replies are now drawn twelve times a second — the same smooth stream, at a fraction of the cost — and three smaller per-render costs are gone with it (a scan of every message per token, pictures re-fetched on every scroll, a screenshot of the browser pane every 1.2 seconds).

**The simulator embed keeps trying.** The pane gave up embedding the simulator's screen after two and a half minutes — which an agent's build-and-install often outlasts — and streamed for the rest of the session. It now retries for as long as the pane is open, and switches the moment the screen is there.

**A hot window gets named.** When the window stays above 120% CPU, Superagent profiles it for five seconds and writes the hottest functions to its `memory.log`, so the next "why is it so slow" has an answer from your Mac rather than a guess.
