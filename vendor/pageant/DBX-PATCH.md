# DBX Windows 7 compatibility patch

This is `pageant` 0.2.1 with WinRT `HSTRING` removed from Pageant window and
mapping names. It uses null-terminated UTF-16 strings instead and pins the
compatible Windows bindings to 0.61.3, avoiding COMBASE and WinRT imports that
are unavailable on Windows 7.
