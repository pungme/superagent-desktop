# Spike: clicking in a background window without taking focus

Not built, not shipped, not run by any test. Sources for the experiment on the
board card "Computer use 10". Run by hand on macOS 27 (Darwin 27.0), Electron 39,
on 2026-10-10.

    clang -fobjc-arc -framework Cocoa -o target target.m          # AppKit window, behind everything
    clang -framework ApplicationServices -o bg bgclick.c
    ./target &            # prints its pid; exits by itself after a minute
    ./bg cg <pid> 200 60 left 48     # CGEventPostToPid, tied to the window
    ./bg sl <pid> 200 60 left 48     # SLEventPostToPid (private, SkyLight)
    ./bg drag|scroll|key|ax <pid> …

`chromium-target.js` is the same thing as an Electron window that is shown but
invisible (opacity 0), unfocusable and click-through to the real mouse.

## What was found

A click reaches a background window, with the app staying inactive, the app in
front unchanged and the real pointer not moving, when the event carries:

- field 51 (the window id the event belongs to), and
- `CGEventSetWindowLocation` (private symbol): the point relative to the window.

Without those the app receives the event with window number 0 and drops it.
Fields 91/92 (window under the pointer) are not what AppKit reads.

| | AppKit window | Chromium (Electron 39) |
|---|---|---|
| Left click (`CGEventPostToPid`, public) | delivered, button pressed | delivered, `isTrusted`, user activation set |
| Left click (`SLEventPostToPid`, private) | same | same |
| Right click | delivered as right | delivered as button 2, `contextmenu` fires |
| Drag | delivered (down, dragged ×3, up) | not tried |
| Scroll wheel | NOT delivered to the view | not tried |
| Keys (`CGEventPostToPid`) | delivered to the first responder | not delivered (the page has no focus) |
| Window never shown (`show: false`) | n/a | nothing delivered |
| Accessibility: AXPress, set AXValue | works, no focus change | not tried |

So on this macOS the private SkyLight post was NOT needed: the public
`CGEventPostToPid` does it once the event names its window. The two private
pieces are field 51 and `CGEventSetWindowLocation`.

The right-click problem the cua write-up describes (Chromium coercing it to a
left click) did not show in Electron 39. Real Chrome, canvas apps (Blender,
Unity), other Spaces, minimised windows and full-screen apps were not tried:
they are the user's own windows, and a spike does not click in those.

## What it would take to ship

- Which window: the id of the window the agent means (`cuse at` already finds
  the owner; it needs the window id and frame too).
- Typing: keys go to the app's first responder, which a background click may
  not have changed. Setting a field through accessibility (AXValue) is surer.
- Scroll does not arrive; needs another route (AXScroll actions, or events of a
  different kind).
- Private symbols can change in any macOS update: look them up with `dlsym`,
  and fall back to the foreground path when one is missing.
- Every guard computer use has today is about the app in FRONT or under the
  pointer. Background clicks need them restated for "the window being clicked",
  and an on-screen sign of where it is acting, since nothing moves.
- The accessibility route (AXPress / AXValue / menu items) is supported API,
  already works in the background, and should be built first.

## Codex

`codex-cli 0.155.1` lists a `computer_use` feature (stable, on by default) with
its own config (`ComputerUseConfigToml`, `default_app_access`, per-platform
sections) and a confirmation policy. Whether it works from the app-server
without Codex's desktop app was not established. Superagent now starts Codex
threads and routines with `features.computer_use = false`, so that using the
Mac only ever goes through Superagent's own tools and consent.
