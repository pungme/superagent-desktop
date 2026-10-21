# Superagent 2.0.0-beta.75

**Each conversation sees its own simulator.** Superagent gives every conversation its own device, but the simulator pane remembered devices per project. With two conversations in one project, the pane in one could show the other's phone — and then tell the app that phone was its own, so its agent built and installed onto the wrong simulator. An agent booting a device in one conversation could also swap the pane in another. The pane now keeps its device per conversation, asks the app which device belongs to the conversation on screen, and follows only that conversation's agent.

After updating, a pane may ask you to pick its simulator once, or pick it up as soon as the agent uses one.
