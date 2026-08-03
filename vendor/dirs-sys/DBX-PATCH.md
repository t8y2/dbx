# DBX Windows 7 compatibility patch

This is `dirs-sys` 0.5.0 with `CoTaskMemFree` linked directly from
`ole32.dll`. `windows-sys` 0.61 links that function from `combase.dll`, which
is unavailable on Windows 7.
