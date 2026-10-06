# Superagent 1.9.3-beta.9

- **Each conversation gets its own simulator.** Two conversations building at once used to end up on the same simulator and install over each other. A conversation now takes a simulator nobody else is using, and when the one that is running is taken it gets a second one of the same model (created if there is no spare). It shares one only when you ask for that.
- **Deleting a project's conversation asks first.** The × on a chat under a project deleted it on one click. It now asks, like the Chats list does. An unused New chat still goes without a question.
- **⌘K no longer hides behind the browser.** With the browser open, the palette could sit under the page for up to a second. The browser now steps aside within a fraction of a second.
