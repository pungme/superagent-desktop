# Superagent 2.0.0-beta.64

**Flip through a chat's pictures.** With a picture open full size, press ← or → (or click the arrows at the sides) to go to the previous or next picture in the conversation. The top bar shows where you are, such as "3 of 12".

**Long conversations no longer hammer the disk.** While an agent was working, Superagent rewrote the whole conversation every few seconds — for a long chat with pictures, tens of megabytes each time, and over a day of work that could add up to more than a hundred gigabytes written. It now saves only what changed, off the main thread, so a 75 MB conversation writes a few hundred kilobytes per turn. Existing conversations move over the first time you open them, and the original copy is kept.

**Saving can't silently fail.** If a conversation can't be saved, the chat says so with a Retry button, and quitting waits until everything is written.

**Setup says what's missing.** When an agent isn't ready, setup now tells you whether it isn't installed, needs Node, needs signing in, or the check itself failed — and asks before it installs anything or starts a sign-in.

**Codex installed with npm or a Node version manager starts reliably.** beta.62 could still miss Node when Superagent was opened from the Dock.
