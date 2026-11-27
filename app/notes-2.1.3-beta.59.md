# Superagent 2.1.3-beta.59

**Our own right-click menu.** Right-clicking a project, a chat, a branch or a file in the sidebar now opens Superagent's own menu instead of the macOS one: same items, same actions, drawn in the app's style, with arrows, Return and Esc, and the destructive ones (Delete, Remove, Clear) in red.

**Tested.** Unit tests for how a menu is described, and an e2e that right-clicks a chat, closes it with Esc, picks "Pin chat" and checks the chat is pinned. The browser pane's own page menus are still the native ones.
