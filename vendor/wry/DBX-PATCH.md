# DBX patch

DBX vendors Wry 0.55.1 to pass `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` directly
to both WebView2 Runtime discovery and environment creation on the Win7 target.

Upstream Wry passes a null browser folder to these APIs. That works with the
Evergreen Runtime but prevents DBX's Windows 7 build from reliably selecting
its bundled WebView2 109 Fixed Runtime. Other Windows targets retain the
upstream null-folder behavior.
