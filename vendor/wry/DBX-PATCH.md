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
