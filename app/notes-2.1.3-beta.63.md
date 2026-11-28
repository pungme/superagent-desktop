# Superagent 2.1.3-beta.63

**Conductor, the rest of the plan.**
- **Routing pill in Main's composer:** Confirm or Auto, right beside Mode and Browser.
- **Move ▾ on a "Sent" receipt:** if Main sent your message to the wrong session, move it to another one in a click; the first one is told to leave it.
- **Main knows every session:** sessions connected from existing chats now get a record in Main's memory straight away (title, first request, branch, files), not only after their next turn. A record keeps its task when the session is renamed or closed, and says how it ended.

**Fixed.** The Move menu no longer opens underneath the next message.

**Tested.** e2e for the routing pill, a routing receipt and Move (the message reaches the new session and the old one is told to leave it), records for connected and closed sessions.
