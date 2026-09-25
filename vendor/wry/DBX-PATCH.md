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
