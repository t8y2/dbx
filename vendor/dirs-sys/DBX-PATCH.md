# DBX Windows 7 compatibility patch

This is `dirs-sys` 0.5.0 with `CoTaskMemFree` linked directly from
`ole32.dll` only for the Win7 target. `windows-sys` 0.61 links that function
from `combase.dll`, which is unavailable on Windows 7. Other Windows targets
retain the upstream `windows-sys` implementation and dependency features.
