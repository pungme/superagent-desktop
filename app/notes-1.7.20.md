## Superagent 1.7.20 — adding a folder works on the first go

One line, and it is the one that has been wasting your time:

```
return { tree: getTree(), workspaceId: createWorkspace(groupId, name, path) }
```

Object properties are evaluated in order, so the project list was read **before** the project was created. The window was handed the sidebar as it looked a moment earlier — the project was in the database and not on screen. Adding it again showed the first one, because by then the list included it, and quietly made a second one at the same time.

That is the whole of "I had to add the folder twice". It is also why deleting sometimes took two goes, and why a project could appear twice in a group: the second add had made a real second project.

If you already have a duplicate, deleting one of them is safe — they are separate projects pointing at the same folder.

Nothing else is in this release. It is cut from 1.7.19 with only this change.
