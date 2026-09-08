# Superagent 1.9.0-beta.2

Beta channel.

- Long chats are now fast. The transcript only renders the messages near the viewport instead of every message in the session, so opening, scrolling and typing in a long conversation stay smooth. In the largest local chat this cut the on-screen transcript from ~2000 message bubbles (3367 DOM nodes) to about 15 bubbles, with no visible change: it still opens on the latest message, user bubbles still sit on the right, the arrival animation still plays for new messages, and the view stays pinned to the bottom while a reply streams.
