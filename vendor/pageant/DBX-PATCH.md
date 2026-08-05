# DBX Windows 7 compatibility patch

This is `pageant` 0.2.1 with WinRT `HSTRING` removed from Pageant window and
mapping names. It uses null-terminated UTF-16 strings instead. The Win7 target
uses Windows bindings 0.61.3 to avoid COMBASE and WinRT imports unavailable on
Windows 7, while other Windows targets retain the upstream 0.62 dependency.
