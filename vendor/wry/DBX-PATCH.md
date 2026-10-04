# DBX patch

DBX vendors Wry 0.55.1 to pass `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` directly
to both WebView2 Runtime discovery and environment creation on the Win7 target.

Upstream Wry passes a null browser folder to these APIs. That works with the
Evergreen Runtime but prevents DBX's Windows 7 build from reliably selecting
its bundled WebView2 109 Fixed Runtime. Other Windows targets retain the
upstream null-folder behavior.

On macOS, DBX also updates Wry's pasteboard and modifier-key APIs for
`objc2-app-kit` 0.3.2 and removes `unsafe` blocks around methods that are now
exposed as safe. This keeps file drag-and-drop behavior while avoiding
deprecated AppKit constants and compiler warnings.

On macOS, DBX also gates `WryWebViewParent.keyDown:` menu key-equivalent
forwarding on Command/Control modifiers, returns early when the menu handles
the event, and sinks remaining unhandled events via `interpretKeyEvents`
(preserving upstream's no-NSBeep behavior from wry#742). Without the gate,
every keyDown was passed to `performKeyEquivalent`, which silently swallowed
keys that matched no menu accelerator before they reached the WKWebView
content (iframe-based apps included); Option-modified keys stay untouched for
dead-key/compose input. This matches the proposal in upstream
tauri-apps/wry#1711 (see also tauri-apps/wry#1175, #1177) and unblocks
in-app shortcuts such as the table structure editor (t8y2/dbx#7245,
landed via PR #8650).

On macOS, DBX also adds `WryWebViewParent.dbxUpdateTrafficLightInsetX:y:` and
makes `inset_traffic_lights` place the buttons' vertical position explicitly
(top-down center-delta against the window frame) instead of relying on AppKit's
title bar layout. Three writers fought over the button frames during a live
window resize — AppKit's layout pass, the one-shot `set_macos_traffic_light_
position` placement, and wry's `drawRect:` re-application of the creation-time
inset — which made the traffic lights jump while dragging the window edge.
DBX pushes its dynamic toolbar-aligned position through the new method so the
`drawRect:` re-application replays the latest inset, and both writers converge
on the same explicit placement. Without it, the stored static inset and AppKit
layout disagree on every resize pass (see upstream tauri-apps/wry#1747 and
tauri-apps/tauri#15451).
