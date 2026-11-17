# Superagent 2.1.3-beta.16

**"You're out of usage credits. Switch to another model" no longer stops the chat.** That message means the model the chat is on has used up its own weekly allowance (often Fable), not your account. Superagent read it as the whole account being out and stopped. Now it moves the chat to the next model down (Fable to Opus) and sends your message again, the same as when Claude Code names the model that ran out.
