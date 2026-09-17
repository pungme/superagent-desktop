# Superagent 1.9.1-beta.12

- Fixed the iOS Simulator pane rendering a landscape device as if it were still portrait-shaped — a stale size reading could get stuck at 0×0 and never get corrected, silently falling back to unrotated sizing.
- Each browser tab now tracks its own page correctly — a second tab no longer gets stuck reading "New tab" (it was sharing the first tab's page-url tracking).
- Settings → Advanced → Storage now breaks "Conversations" down by project, sorted largest first, with a "Clear" action per project.
- A quick follow-up message now visibly pulls in closer to the one before it (not just its timestamp fading — the actual gap tightens, with an animation).
- Board/Todo cards show a relative timestamp ("now", "25m", "3h"…).
