## Superagent 1.7.4 — fixes 1.7.2 / 1.7.3 opening empty

If you updated to 1.7.2 or 1.7.3 and Superagent came up with no projects and no chats: nothing was deleted. The rename in 1.7.2 also changed the internal name the app uses to find its data folder and its keychain key, so it was looking in the wrong place. 1.7.4 puts the internal name back; your projects, chats and logins are exactly where you left them.

Anything created while on 1.7.2/1.7.3 lived in a separate folder (`~/Library/Application Support/Superagent`) and isn't merged automatically — tell us if you need it.
