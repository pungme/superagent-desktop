## SuperAgent 1.5.18

### Fixes
- **Unclickable middle column** — a memory optimisation in 1.5.17 could free a background chat's preview view while that chat was still open, leaving the middle column (file tree + preview) dead until a reload. Reverted; panes are still freed when a chat or project is actually closed.
- **Dropdowns paint on top now** — the branch switcher opened *behind* the browser/PDF pane (native pages paint above the app's own UI) and could sit under chat bubbles. Menus now render on a top-level layer and take the same "freeze the page" lock the snip uses, so they're always visible and clickable.
- **The file chip opens the file** — clicking the toolbar 📄 chip showed whatever the pane last had (often localhost) instead of the named PDF/image. The name now always opens that document; the ✕ closes the pane.
- **Omnibar keeps its URL** — reopening a session with a website loaded left the URL bar empty until the next navigation; it now shows the page's address immediately.
- **Killed background jobs clear themselves** — a job ending with a `[killed]` marker used to stay pinned to the "Running in background" strip forever.

### Polish
- **On-brand thinking indicator** — the three grey dots are now the app mark: a light dot orbiting inside the black tile while Claude works.
