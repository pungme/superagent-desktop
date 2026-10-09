# Superagent 1.9.4

- **Connecting a phone could crash Superagent.** When what the Mac sent a phone did not line up with what the phone held, the phone asked for the conversation again, and the Mac answered every ask in full, at once. A phone that kept asking was sent the same conversation over and over until Superagent ran out of memory and quit, taking every running agent with it. The Mac now sends a catch-up only as fast as the connection carries it, answers a phone that keeps asking less and less often, and drops and remakes the link rather than hold more than it can send.
- **Superagent reopens after a crash.** If it goes down without being quit, it opens again by itself a moment later. Quitting it yourself still quits it.
- **A gap between pinned chats.** The open chat and the one under the pointer no longer run into one block.
