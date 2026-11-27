# Superagent 2.1.3-beta.43

**Messages from your phone no longer kill what the agent is running.** The phone sends the model it last picked, whichever agent that was. A Gemini model on a Claude chat never took effect, so every message looked like a change of model and Superagent stopped and restarted the agent each time. Anything it had running in the background, like a health monitor, died with it ("didn't finish before the previous session ended"). A model or mode that belongs to another agent is now ignored.

**A browser you close stays closed.** If you quit Brave (or close its last window) while an agent is using it, the agent no longer opens it again by itself. It tells you what it was about to do and asks. It opens again when you next send a message or click Open window.

**Contacts is a table.** Name with initials, a coloured status, the next follow-up and your first custom field line up under column headers, with filters and search. "Update our CRM" now means these contacts: the agent reads them first instead of asking where the CRM lives.

**A start screen for new people.** With no project yet, the middle of the window says "What do you want to get done?" with a Start a chat button, a way to open a folder, and four starters that send themselves.

**Smaller things.** Delete a to-do from Today (× on hover). Mail drafts and sends take a from address, so a draft lands in the right account; Gmail folders in mail_accounts are the paths mail_search accepts. Unused simulators delete themselves after three days (a Keep button protects one).
