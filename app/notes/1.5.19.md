## SuperAgent 1.5.19

### Performance
- **The transcript only re-renders what changed.** Every streamed token used to re-render every bubble in the conversation (and typing in the composer did too). Each bubble is now independently memoized with stable identities, so streaming and typing touch only the live row — long conversations stay snappy.
- **Syntax highlighting waits for the code to finish.** Highlighting re-ran over the whole growing code block on every update while Claude streamed code; it now highlights once, when the block settles.
- **Smoother auto-scroll** — coalesced to the display's frame rate and skipped entirely for background chats.
- **Fewer wasted re-renders** — sidebar rows and workspace panes subscribe to exactly the state they show.

### Fixes
- **Reply button on short messages** — in a narrow chat column, Reply could sit underneath Copy on one-line messages and couldn't be clicked; it now sits beside it.
