## Superagent 1.7.25 — one browser session, and a switch you can read in the dark

**A login done in one project had to be done again in the next.** Every code project browsed in its own cookie jar, so signing in somewhere — or passing one of those "verify you are human" checks, which hands out a pass tied to the jar that earned it — counted for that project and nothing else. There is now one session for the whole app, the way a real browser works rather than handing you a fresh profile per folder you have open. Logins already on this Mac are carried over on first launch; nothing is deleted.

**The Activity / Projects switch was invisible in dark mode.** The selected side was drawn white whatever the theme, and the label on it is white too, so in dark mode you got a blank pill where the word should be. Both themes now have their own colour for it.

**Reply to a message, from your phone as well as here.** Hold a message — yours or the agent's — and Reply. The quote sits above the composer until the message goes, then appears above it on every device showing that conversation. The window has had this for a while; the phone could not do it at all, because the quote was built into the text handed to the agent and never travelled. It is its own thing on the wire now, so what you send stays exactly what you typed.

**Popups no longer open behind the browser page.** A page in a pane is drawn by the system on top of the app's own window, so no amount of layering in CSS can put anything above it — the page has to be taken away first. Three things never asked for that: the permission prompt, the branch menu and the opening splash. The permission prompt was the worst of them, able to ask a question from underneath the page it was asking about.
