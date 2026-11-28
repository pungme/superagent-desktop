# Superagent 2.1.3-beta.67

**Auto stops going round in circles.** Auto kept asking "anything left?" while the agent was only waiting on you, and got the same answer every time. Now it also stops when the agent says it is waiting on you without a question mark ("…then tell me", "I need you to…"), when it gives the same answer as the round before, and while a /loop is running in the chat (the loop already brings the agent back). The agent is asked to end with a question when it needs you.

**Readable Auto bubbles.** "Auto: asked whether anything is left" was dark text on the dark bubble; it now takes the bubble's own colour.

**Tested.** Unit tests for each new reason to stop; the full suite.
