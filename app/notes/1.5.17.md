## SuperAgent 1.5.17

### Performance
- **Lighter streaming** — the transcript now updates once per animation frame instead of once per token, so a fast-streaming reply no longer pegs the CPU or stutters on a long conversation.
- **Much lower memory** — each conversation's browser/preview pane is a full Chromium view (~100MB). They used to leak — a deleted chat never freed its view, and removing a project leaked every chat's view. Now they're freed when a chat or project goes away, with a cap that closes long-idle background panes (they reload from their saved URL when you return).

### Fixes
- **Close an opened PDF/image** — the toolbar file chip (📄 name) is now a real close button (✕) while a document is open, so a PDF/image in the middle column always has a way out.

### Update banner
- **"What's new"** — the "ready to install" banner now has a "What's new" button that shows the release notes on hover or click.
