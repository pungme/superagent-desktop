### Calendar — a real calendar
- **Day / Week / Month views.** Week and Day are proper time-grids: hour lines, events as positioned blocks (overlapping events sit side by side), a live "now" line, and click a slot to create an event.
- **Import from .ics** — pull events straight from Google Calendar, Apple Calendar, or an Outlook export.

### Settings is a full page
Not a cramped dialog anymore — a proper page with a section nav (General · Notifications · Advanced · About), with room to grow.

### Fixed
- **Browser panes line up with their frame.** The native web view could sit a few pixels off after opening; it now re-aligns cleanly — which also means the window controls on the Computer's Browser window are clickable again.
- **Model / Mode menus close when you click away.**
- Switching a chat no longer stacks duplicate "ended the turn" notices.

### Security
- **A guardrail against web-page prompt injection.** When the agent reads a web page and then tries to run a command or change a file in the same turn, SuperAgent pauses for a one-tap approval — ordinary coding stays fully autonomous. Page text handed to the agent is also fenced as untrusted.
- The local helper servers no longer write their secret to the logs.
