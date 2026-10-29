# Superagent 2.1.0-beta.17

**When the agent goes quiet, the chat says why.** Inside a long step (a deploy, a build, a wait loop) the agent reads nothing until that step returns. The Working line now says which step it is in and for how long, for example "Terminal gh run watch … · 4m 12s".

**Messages you send meanwhile say they are waiting.** A note under it reads "Your 2 messages wait until this step finishes", with **Stop and answer**: it stops the step and hands the agent what you wrote. (Esc and ⌘↩ did this already, but nothing on screen said so.)
